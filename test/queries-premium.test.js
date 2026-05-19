// Unit tests for src/queries-premium.js. Uses an in-memory SQLite DB
// seeded with deterministic rows so the premium aggregates are
// reproducible. No network, no x402.

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { openTestDb } from '../src/db.js';
import {
	getPremiumOpportunities,
	build7dMarketIntel,
	buildOurAttemptIntel
} from '../src/queries-premium.js';

const NOW = 1_750_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const BOR_A = '0x' + 'a'.repeat(40);
const BOR_B = '0x' + 'b'.repeat(40);
const BOR_C = '0x' + 'c'.repeat(40);
const BOR_M = '0x' + 'd'.repeat(40);
const LIQ_X = '0x' + '1'.repeat(40);
const LIQ_Y = '0x' + '2'.repeat(40);
const COLL_WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const DEBT_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const COLL_WSTETH = '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0';
const MORPHO_MARKET = '0xdeadbeef' + 'f'.repeat(56);

let db;
let dateNowSpy;

beforeAll(() => {
	// Freeze Date.now so the window math is deterministic. Jest's
	// jest.spyOn(Date, 'now') would also work; we use a manual install
	// so the file is jest-config-agnostic.
	const realNow = Date.now;
	Date.now = () => NOW;
	dateNowSpy = realNow;

	db = openTestDb();

	// Aave snapshot: A is critically at risk, B is healthy, C is mid.
	const insertSnap = db.prepare(`
		INSERT INTO borrower_snapshots
			(borrower_address, last_seen_ts, block_number, health_factor,
			 total_collateral_usd, total_debt_usd, liquidatable)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`);
	insertSnap.run(BOR_A, NOW - 60_000, 25_000_000, 0.95, 10000, 9800, 1);
	insertSnap.run(BOR_B, NOW - 60_000, 25_000_001, 1.40, 50000, 30000, 0);
	insertSnap.run(BOR_C, NOW - 60_000, 25_000_002, 1.02, 25000, 24500, 0);

	// Morpho snapshot: borrower with ltv/lltv around 1.
	const insertM = db.prepare(`
		INSERT INTO morpho_borrower_snapshots
			(market_id, borrower_address, last_seen_ts, block_number,
			 ltv, lltv, debt_usd, distance_to_liquidation)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`);
	insertM.run(MORPHO_MARKET, BOR_M, NOW - 60_000, 25_000_003, 0.99, 1.01, 1500, 0.02);

	// Missed liquidations: 5 wins, 3 by LIQ_X and 2 by LIQ_Y.
	const insertMiss = db.prepare(`
		INSERT INTO missed_liquidations
			(timestamp, block_number, tx_hash, borrower_address,
			 collateral_asset, debt_asset, debt_to_cover, liquidated_collateral,
			 liquidator, was_tracking, would_have_been_profitable, debt_usd)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	// 3 wins inside both 24h and 7d windows (12h ago, by LIQ_X, WETH collateral).
	for (let i = 0; i < 3; i += 1) {
		insertMiss.run(NOW - DAY_MS / 2 - i * 1000, 25_000_100 + i,
			`0xtx${'a'.repeat(60)}${i}`, BOR_A, COLL_WETH, DEBT_USDC, '1000', '1', LIQ_X, 0, 1, 1000 + i * 100);
	}
	// 2 wins inside 7d but outside 24h (3 days ago, by LIQ_Y, wstETH collateral).
	for (let i = 0; i < 2; i += 1) {
		insertMiss.run(NOW - 3 * DAY_MS - i * 1000, 25_000_200 + i,
			`0xtx${'b'.repeat(60)}${i}`, BOR_B, COLL_WSTETH, DEBT_USDC, '500', '1', LIQ_Y, 1, 0, 500 + i * 50);
	}
	// One ancient row outside the 7-day window — must be excluded.
	insertMiss.run(NOW - 30 * DAY_MS, 24_900_000, '0xtxold' + '0'.repeat(58),
		BOR_C, COLL_WETH, DEBT_USDC, '999', '1', LIQ_X, 0, 0, 999);

	// Our executions for the 7d window.
	const insertExec = db.prepare(`
		INSERT INTO executions
			(timestamp, block_number, opportunity_id, strategy, borrower_address,
			 tx_hash, success, error, actual_profit_usd, gas_used_usd)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	insertExec.run(NOW - 3600_000, 25_000_300, null, 'aave_bundle_submit',
		BOR_A, '0xa1', 0, 'timeout', null, 1.5);
	insertExec.run(NOW - 3600_000 * 2, 25_000_301, null, 'aave_bundle_submit',
		BOR_A, '0xa2', 0, 'timeout', null, 1.5);
	insertExec.run(NOW - 3600_000 * 3, 25_000_302, null, 'of_bundle_submit_atomic',
		BOR_A, '0xa3', 0, 'missed', null, 0);

	// Our morpho attempts.
	const insertAtt = db.prepare(`
		INSERT INTO morpho_attempts
			(timestamp, block_number, market_id, borrower_address,
			 ltv, lltv, debt_usd, estimated_profit_usd, preflight,
			 outcome, stage, reason, tx_hash, gas_used)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	for (let i = 0; i < 14; i += 1) {
		insertAtt.run(NOW - i * 3600_000, 25_000_500 + i, MORPHO_MARKET, BOR_M,
			0.99, 1.01, 1500, 80, 0, 'skipped', 'route', 'no_swap_route', null, null);
	}
});

afterAll(() => {
	if (dateNowSpy) Date.now = dateNowSpy;
});

describe('build7dMarketIntel', () => {
	test('aggregates per-pair and per-liquidator over the window', () => {
		const intel = build7dMarketIntel(db, NOW - 7 * DAY_MS);
		expect(intel.summary.missed_liquidations).toBe(5);
		expect(intel.summary.distinct_pairs).toBe(2);
		const liq = intel.summary.top_liquidators;
		expect(liq[0].address).toBe(LIQ_X);
		expect(liq[0].won_count).toBe(3);
		expect(liq[1].address).toBe(LIQ_Y);
		expect(liq[1].won_count).toBe(2);
	});

	test('excludes rows outside the window', () => {
		const intel = build7dMarketIntel(db, NOW - DAY_MS);
		expect(intel.summary.missed_liquidations).toBe(3);
	});

	test('top_collateral_assets is ordered by count desc', () => {
		const intel = build7dMarketIntel(db, NOW - 7 * DAY_MS);
		const top = intel.summary.top_collateral_assets;
		expect(top[0].asset).toBe(COLL_WETH);
		expect(top[0].count).toBe(3);
		expect(top[1].asset).toBe(COLL_WSTETH);
		expect(top[1].count).toBe(2);
	});
});

describe('buildOurAttemptIntel', () => {
	test('groups executions by strategy and morpho by outcome', () => {
		const ours = buildOurAttemptIntel(db, NOW - 7 * DAY_MS);
		const aave = Object.fromEntries(ours.aave_by_strategy.map(r => [r.strategy, r]));
		expect(aave.aave_bundle_submit.total).toBe(2);
		expect(aave.aave_bundle_submit.wins).toBe(0);
		expect(aave.of_bundle_submit_atomic.total).toBe(1);

		const morpho = Object.fromEntries(ours.morpho_by_outcome.map(r => [r.outcome, r]));
		expect(morpho.skipped.total).toBe(14);
		expect(morpho.skipped.markets).toBe(1);
	});

	test('morpho_by_market keyed by market_id', () => {
		const ours = buildOurAttemptIntel(db, NOW - 7 * DAY_MS);
		const m = ours.morpho_by_market.get(MORPHO_MARKET);
		expect(m).toBeTruthy();
		expect(m.attempts).toBe(14);
		expect(m.skipped).toBe(14);
		expect(m.success).toBe(0);
	});
});

describe('getPremiumOpportunities', () => {
	test('returns a feed sorted by expected_value_usd desc', () => {
		const feed = getPremiumOpportunities(db, { min_debt_usd: 0 });
		expect(Array.isArray(feed.opportunities)).toBe(true);
		// At-risk Aave row + Morpho row.
		expect(feed.opportunities.length).toBeGreaterThanOrEqual(2);
		for (let i = 0; i + 1 < feed.opportunities.length; i += 1) {
			expect(feed.opportunities[i].expected_value_usd)
				.toBeGreaterThanOrEqual(feed.opportunities[i + 1].expected_value_usd);
		}
	});

	test('annotates Morpho rows with our_attempt_intel from morpho_attempts', () => {
		const feed = getPremiumOpportunities(db, { min_debt_usd: 0 });
		const morphoRow = feed.opportunities.find(r => r.protocol === 'morpho');
		expect(morphoRow).toBeTruthy();
		expect(morphoRow.our_attempt_intel).toBeTruthy();
		expect(morphoRow.our_attempt_intel.attempts).toBe(14);
	});

	test('expected_value_usd uses the supplied liquidation_bonus', () => {
		const a = getPremiumOpportunities(db, { liquidation_bonus: 0.05 });
		const b = getPremiumOpportunities(db, { liquidation_bonus: 0.10 });
		const aRow = a.opportunities.find(r => r.borrower === BOR_A);
		const bRow = b.opportunities.find(r => r.borrower === BOR_A);
		expect(aRow.expected_value_usd).toBeGreaterThan(0);
		expect(bRow.expected_value_usd).toBeCloseTo(aRow.expected_value_usd * 2, 1);
	});

	test('rejects malformed since_ms', () => {
		expect(() => getPremiumOpportunities(db, { since_ms: 'yesterday' }))
			.toThrow(/since_ms/);
	});

	test('rejects out-of-range liquidation_bonus', () => {
		expect(() => getPremiumOpportunities(db, { liquidation_bonus: 1.5 }))
			.toThrow(/liquidation_bonus/);
		expect(() => getPremiumOpportunities(db, { liquidation_bonus: 0 }))
			.toThrow(/liquidation_bonus/);
	});

	test('returns network_status with sensible counts', () => {
		const feed = getPremiumOpportunities(db, {});
		expect(feed.network_status.liquidations_observed_in_window).toBe(5);
		expect(feed.network_status.total_at_risk_seen).toBeGreaterThan(0);
		expect(feed.network_status.last_observed_liquidation.won_by).toBe(LIQ_X);
	});

	test('honours the limit parameter even when more borrowers match', () => {
		const feed = getPremiumOpportunities(db, { limit: 1 });
		expect(feed.opportunities.length).toBe(1);
	});
});
