// Tests for the new premium builder-stats endpoint logic.
// Pure functions only — file streaming is exercised in
// integration tests via rest-server.test.js.

import { describe, test, expect } from '@jest/globals';
import {
	summariseBidDistribution,
	buildBuilderStatsSummary,
	paramBuilderWindow
} from '../src/queries-premium.js';

describe('summariseBidDistribution', () => {
	test('returns null for empty input', () => {
		expect(summariseBidDistribution([])).toBeNull();
		expect(summariseBidDistribution(null)).toBeNull();
	});

	test('extracts canonical percentiles by nearest rank', () => {
		// Even spacing — easy to eyeball the percentile picks.
		const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
		const s = summariseBidDistribution(sorted);
		expect(s.count).toBe(100);
		expect(s.median_eth).toBe(51); // floor(0.5*100) = 50 → bids[50] = 51
		expect(s.p25_eth).toBe(26);    // floor(0.25*100) = 25 → bids[25] = 26
		expect(s.p75_eth).toBe(76);
		expect(s.p90_eth).toBe(91);
		expect(s.p99_eth).toBe(100);
		expect(s.max_eth).toBe(100);
		// mean of 1..100 = 50.5
		expect(s.mean_eth).toBeCloseTo(50.5, 3);
	});

	test('single-sample distribution collapses to that value', () => {
		const s = summariseBidDistribution([0.42]);
		expect(s.count).toBe(1);
		expect(s.median_eth).toBe(0.42);
		expect(s.max_eth).toBe(0.42);
		expect(s.mean_eth).toBe(0.42);
	});
});

describe('buildBuilderStatsSummary', () => {
	const NOW = 1_780_000_000_000;
	const HOUR_MS = 60 * 60 * 1000;
	const WINDOW = 24 * HOUR_MS;

	function shadow(opts) {
		return {
			ts_ms: opts.ts_ms,
			extra_data: opts.builder,
			actual_total_wei: opts.weiString
		};
	}

	test('filters by window and groups by builder', () => {
		const rows = [
			// In-window
			shadow({ ts_ms: NOW - 1 * HOUR_MS, builder: 'beaver',  weiString: '1000000000000000000' }), // 1 ETH
			shadow({ ts_ms: NOW - 2 * HOUR_MS, builder: 'beaver',  weiString: '500000000000000000'  }), // 0.5
			shadow({ ts_ms: NOW - 3 * HOUR_MS, builder: 'titan',   weiString: '100000000000000000'  }), // 0.1
			shadow({ ts_ms: NOW - 4 * HOUR_MS, builder: 'titan',   weiString: '200000000000000000'  }), // 0.2
			// Out of window
			shadow({ ts_ms: NOW - 48 * HOUR_MS, builder: 'beaver', weiString: '999000000000000000' })
		];
		const s = buildBuilderStatsSummary({ rows, windowMs: WINDOW, asOfMs: NOW });
		expect(s.total_slots).toBe(4);
		expect(s.builders).toHaveLength(2);
		const beaver = s.builders.find(b => b.builder === 'beaver');
		expect(beaver.slots_won).toBe(2);
		expect(beaver.share_pct).toBe(50);
		expect(beaver.bid_distribution.max_eth).toBe(1);
		expect(beaver.bid_distribution.median_eth).toBe(1);
		const titan = s.builders.find(b => b.builder === 'titan');
		expect(titan.slots_won).toBe(2);
		expect(titan.bid_distribution.max_eth).toBe(0.2);
	});

	test('builds 24-element hourly histogram', () => {
		const rows = [];
		// 3 slots at UTC hour 0, 1 at hour 12, none elsewhere.
		const day0 = Math.floor(NOW / (24 * HOUR_MS)) * (24 * HOUR_MS);
		rows.push(shadow({ ts_ms: day0 + 1, builder: 'a', weiString: '100' }));
		rows.push(shadow({ ts_ms: day0 + 2, builder: 'a', weiString: '100' }));
		rows.push(shadow({ ts_ms: day0 + 3, builder: 'b', weiString: '100' }));
		rows.push(shadow({ ts_ms: day0 + 12 * HOUR_MS, builder: 'a', weiString: '100' }));
		const s = buildBuilderStatsSummary({ rows, windowMs: WINDOW, asOfMs: day0 + 13 * HOUR_MS });
		expect(s.hourly_distribution).toHaveLength(24);
		expect(s.hourly_distribution[0].slot_count).toBe(3);
		expect(s.hourly_distribution[12].slot_count).toBe(1);
		expect(s.hourly_distribution[5].slot_count).toBe(0);
	});

	test('caps builders to limit', () => {
		const rows = [];
		for (let i = 0; i < 10; i++) {
			rows.push(shadow({ ts_ms: NOW - 1, builder: `builder-${i}`, weiString: '100' }));
		}
		const s = buildBuilderStatsSummary({ rows, windowMs: WINDOW, asOfMs: NOW, limit: 3 });
		expect(s.builders).toHaveLength(3);
	});

	test('handles bigint-string wei safely', () => {
		const rows = [
			// 0.00001 ETH bid, then 1 ETH — distribution should reflect both
			shadow({ ts_ms: NOW - HOUR_MS, builder: 'a', weiString: '10000000000000' }),
			shadow({ ts_ms: NOW - HOUR_MS, builder: 'a', weiString: '1000000000000000000' })
		];
		const s = buildBuilderStatsSummary({ rows, windowMs: WINDOW, asOfMs: NOW });
		expect(s.builders[0].bid_distribution.max_eth).toBe(1);
		expect(s.builders[0].bid_distribution.median_eth).toBe(1); // floor(0.5*2)=1 → bids[1] = 1
	});
});

describe('paramBuilderWindow', () => {
	test('default 7 days', () => {
		expect(paramBuilderWindow({})).toBe(7 * 24 * 60 * 60 * 1000);
	});
	test('clamps oversized windows down to 30 days', () => {
		expect(paramBuilderWindow({ window_ms: 365 * 24 * 60 * 60 * 1000 })).toBe(30 * 24 * 60 * 60 * 1000);
	});
	test('clamps undersized windows up to 1 hour', () => {
		expect(paramBuilderWindow({ window_ms: 100 })).toBe(60 * 60 * 1000);
	});
	test('throws on invalid input', () => {
		expect(() => paramBuilderWindow({ window_ms: 'abc' })).toThrow(/window_ms/);
		expect(() => paramBuilderWindow({ window_ms: 0 })).toThrow(/window_ms/);
	});
});
