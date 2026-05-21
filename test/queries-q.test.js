// Penny Oracle unit tests. All assertions run against an in-memory
// SQLite DB seeded with deterministic rows + an optional on-disk
// shadow-blocks fixture. The point of the tests is to lock in the
// flat response shape — agents in tight loops shouldn't have to
// branch on nullable fields they didn't expect.

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openTestDb } from '../src/db.js';
import {
	qLiquidatable,
	qAtRiskCount,
	qRecentLiquidations,
	qBuilderFacts,
	qCheapestFlashloan,
	qDataFreshness,
	requireAddress,
	requireWindow,
	requirePercentile,
	requireFreshnessSource,
	dispatchQuestion,
	QUESTION_REGISTRY
} from '../src/queries-q.js';

const ADDR_A = '0x' + 'a'.repeat(40);
const ADDR_B = '0x' + 'b'.repeat(40);
const ADDR_C = '0x' + 'c'.repeat(40);
const ADDR_M = '0x' + 'd'.repeat(40);
const ADDR_UNKNOWN = '0x' + 'e'.repeat(40);

const NOW = 1_700_000_100_000;
const FIVE_MIN_MS = 5 * 60 * 1000;

let db;
let tmpRoot;
let shadowPath;

beforeAll(() => {
	db = openTestDb();

	const insertSnap = db.prepare(`
		INSERT INTO borrower_snapshots
			(borrower_address, last_seen_ts, block_number, health_factor,
			 total_collateral_usd, total_debt_usd, liquidatable)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`);
	insertSnap.run(ADDR_A, NOW - FIVE_MIN_MS, 25_000_001, 0.98, 100000, 99000, 1);
	insertSnap.run(ADDR_B, NOW - 2 * FIVE_MIN_MS, 25_000_002, 1.04, 250000, 240000, 0);
	insertSnap.run(ADDR_C, NOW - 3 * FIVE_MIN_MS, 25_000_003, 1.42, 50000, 30000, 0);

	const insertMorpho = db.prepare(`
		INSERT INTO morpho_borrower_snapshots
			(market_id, borrower_address, last_seen_ts, block_number,
			 ltv, lltv, debt_usd, distance_to_liquidation)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`);
	insertMorpho.run('0xmarket-abc', ADDR_M, NOW - FIVE_MIN_MS, 25_000_004, 0.82, 0.86, 78000, 0.04);

	const insertMissed = db.prepare(`
		INSERT INTO missed_liquidations
			(tx_hash, timestamp, block_number, borrower_address,
			 liquidator, debt_asset, collateral_asset,
			 debt_to_cover, liquidated_collateral, debt_usd,
			 was_tracking, would_have_been_profitable)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	const FAKE = '0x' + 'a'.repeat(64);
	insertMissed.run(FAKE, NOW - 30 * 60 * 1000, 25_000_010, ADDR_A, '0xliq', 'USDC', 'WETH', '0', '0', 50_000, 1, 1);
	insertMissed.run(FAKE.replace(/a/g, 'b'), NOW - 90 * 60 * 1000, 25_000_011, ADDR_B, '0xliq', 'USDC', 'WETH', '0', '0', 12_000, 0, 0);

	tmpRoot = mkdtempSync(join(tmpdir(), 'penny-oracle-'));
	shadowPath = join(tmpRoot, 'shadow-blocks.jsonl');
	const lines = [
		JSON.stringify({ slot: 1, ts_ms: NOW - 60_000, extra_data: 'beaverbuild.org', actual_total_wei: '40000000000000000' }), // 0.04 ETH
		JSON.stringify({ slot: 2, ts_ms: NOW - 120_000, extra_data: 'beaverbuild.org', actual_total_wei: '50000000000000000' }), // 0.05
		JSON.stringify({ slot: 3, ts_ms: NOW - 180_000, extra_data: 'beaverbuild.org', actual_total_wei: '60000000000000000' }), // 0.06
		JSON.stringify({ slot: 4, ts_ms: NOW - 240_000, extra_data: 'rsync-builder',  actual_total_wei: '10000000000000000' }),  // 0.01
		JSON.stringify({ slot: 5, ts_ms: NOW - 300_000, extra_data: 'rsync-builder',  actual_total_wei: '20000000000000000' }),  // 0.02
		// Stale one — outside any reasonable window when nowMs=NOW.
		JSON.stringify({ slot: 6, ts_ms: NOW - 40 * 24 * 3600_000, extra_data: 'beaverbuild.org', actual_total_wei: '70000000000000000' })
	];
	writeFileSync(shadowPath, lines.join('\n') + '\n', 'utf8');
});

afterAll(() => {
	if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe('validators', () => {
	test('requireAddress accepts checksummed / unchecksummed', () => {
		expect(requireAddress(ADDR_A)).toBe(ADDR_A);
		expect(requireAddress(ADDR_A.toUpperCase().replace('0X', '0x'))).toBe(ADDR_A);
	});
	test('requireAddress rejects garbage', () => {
		expect(() => requireAddress('not-an-address')).toThrow(/0x-prefixed/);
		expect(() => requireAddress('')).toThrow(/0x-prefixed/);
	});
	test('requireWindow normalises + falls back', () => {
		expect(requireWindow('24h')).toBe('24h');
		expect(requireWindow('7D')).toBe('7d');
		expect(requireWindow(undefined)).toBe('24h');
		expect(() => requireWindow('1y')).toThrow(/24h\|7d\|30d/);
	});
	test('requirePercentile clamps to supported set', () => {
		expect(requirePercentile(50)).toBe(50);
		expect(requirePercentile('90')).toBe(90);
		expect(() => requirePercentile(35)).toThrow(/one of/);
	});
	test('requireFreshnessSource rejects unknown', () => {
		expect(requireFreshnessSource('shadow_blocks')).toBe('shadow_blocks');
		expect(() => requireFreshnessSource('totally-bogus')).toThrow(/must be one of/);
	});
});

describe('qLiquidatable', () => {
	test('hits Aave row with liquidatable=true', () => {
		const r = qLiquidatable(db, { addr: ADDR_A });
		expect(r.found).toBe(true);
		expect(r.protocol).toBe('aave');
		expect(r.liquidatable).toBe(true);
		expect(r.hf).toBeLessThan(1);
		expect(r.debt_usd).toBe(99000);
	});
	test('returns not-liquidatable for healthy Aave row', () => {
		const r = qLiquidatable(db, { addr: ADDR_C });
		expect(r.found).toBe(true);
		expect(r.liquidatable).toBe(false);
		expect(r.hf).toBeGreaterThan(1);
	});
	test('hits Morpho row when protocol filter is set', () => {
		const r = qLiquidatable(db, { addr: ADDR_M, protocol: 'morpho' });
		expect(r.found).toBe(true);
		expect(r.protocol).toBe('morpho');
		// LLTV/LTV = 0.86/0.82 ≈ 1.0488
		expect(r.hf).toBeCloseTo(1.0488, 3);
	});
	test('falls through to found:false for unknown addr', () => {
		const r = qLiquidatable(db, { addr: ADDR_UNKNOWN });
		expect(r).toEqual({
			found: false,
			addr: ADDR_UNKNOWN,
			liquidatable: false,
			hf: null,
			debt_usd: null,
			last_seen_ms: null
		});
	});
	test('rejects garbage address', () => {
		expect(() => qLiquidatable(db, { addr: 'nope' })).toThrow(/addr/);
	});
});

describe('qAtRiskCount', () => {
	test('counts Aave rows below 1.05 default', () => {
		const r = qAtRiskCount(db, {});
		// ADDR_A (hf 0.98) + ADDR_B (hf 1.04) + Morpho ADDR_M (hf ~1.0488).
		expect(r.count).toBe(3);
		expect(r.total_debt_usd).toBeCloseTo(99000 + 240000 + 78000, 0);
	});
	test('protocol filter scopes to Aave only', () => {
		const r = qAtRiskCount(db, { protocol: 'aave' });
		expect(r.count).toBe(2);
		expect(r.total_debt_usd).toBeCloseTo(99000 + 240000, 0);
	});
	test('min_debt_usd filters by size', () => {
		const r = qAtRiskCount(db, { min_debt_usd: 100_000 });
		// Only ADDR_B (240000) clears 100k.
		expect(r.count).toBe(1);
		expect(r.total_debt_usd).toBe(240000);
	});
	test('rejects non-numeric max_hf', () => {
		expect(() => qAtRiskCount(db, { max_hf: 'nope' })).toThrow(/max_hf/);
	});
});

describe('qRecentLiquidations', () => {
	test('default 60min returns one event', () => {
		const r = qRecentLiquidations(db, {}, { nowMs: NOW });
		expect(r.count).toBe(1);
		expect(r.total_debt_usd).toBe(50000);
	});
	test('120min returns both events', () => {
		const r = qRecentLiquidations(db, { since_min: 120 }, { nowMs: NOW });
		expect(r.count).toBe(2);
		expect(r.total_debt_usd).toBe(62000);
	});
	test('rejects negative since_min', () => {
		expect(() => qRecentLiquidations(db, { since_min: -1 }, { nowMs: NOW })).toThrow(/since_min/);
	});
});

describe('qBuilderFacts', () => {
	test('top-builder over 24h returns beaverbuild', async () => {
		const r = await qBuilderFacts({ window: '24h', projection: 'top-builder' }, { shadowPath, nowMs: NOW });
		expect(r.builder).toBe('beaverbuild.org');
		expect(r.slots_won).toBe(3);
		expect(r.total_slots).toBe(5); // stale slot excluded
		expect(r.share_pct).toBe(60);
	});
	test('builder-share with substring match', async () => {
		const r = await qBuilderFacts({ window: '24h', builder: 'beaver', projection: 'share' }, { shadowPath, nowMs: NOW });
		expect(r.builder).toBe('beaver');
		expect(r.slots_won).toBe(3);
		expect(r.share_pct).toBe(60);
	});
	test('builder-bid p50 across 3 samples', async () => {
		const r = await qBuilderFacts({ window: '24h', builder: 'beaver', pct: 50, projection: 'bid' }, { shadowPath, nowMs: NOW });
		expect(r.samples).toBe(3);
		expect(r.pct).toBe(50);
		// Sorted: [0.04, 0.05, 0.06]; floor(1.5) = 1 → 0.05
		expect(r.value_eth).toBeCloseTo(0.05, 6);
	});
	test('builder-bid p99 picks max', async () => {
		const r = await qBuilderFacts({ window: '24h', builder: 'beaver', pct: 99, projection: 'bid' }, { shadowPath, nowMs: NOW });
		expect(r.value_eth).toBeCloseTo(0.06, 6);
	});
	test('30d window pulls in the stale slot', async () => {
		// 30d window still excludes the 40-day-old one.
		const r = await qBuilderFacts({ window: '30d', projection: 'top-builder' }, { shadowPath, nowMs: NOW });
		expect(r.total_slots).toBe(5);
	});
	test('builder substring miss returns zero', async () => {
		const r = await qBuilderFacts({ window: '24h', builder: 'flashbots', projection: 'share' }, { shadowPath, nowMs: NOW });
		expect(r.slots_won).toBe(0);
		expect(r.share_pct).toBe(0);
	});
});

describe('qCheapestFlashloan', () => {
	test('ethereum default returns balancer-v2 (0 bps)', () => {
		const r = qCheapestFlashloan({ asset: 'WETH' });
		expect(r.found).toBe(true);
		expect(r.provider).toBe('balancer-v2');
		expect(r.fee_bps).toBe(0);
	});
	test('rejects missing asset', () => {
		expect(() => qCheapestFlashloan({})).toThrow(/asset/);
	});
	test('unknown chain falls through to found:false', () => {
		const r = qCheapestFlashloan({ asset: 'USDC', chain: 'solana' });
		expect(r.found).toBe(false);
		expect(r.provider).toBeNull();
	});
});

describe('qDataFreshness', () => {
	test('borrower_snapshot age relative to max(last_seen_ts)', () => {
		const r = qDataFreshness(db, { source: 'borrower_snapshot' }, { paths: { shadowPath }, nowMs: NOW });
		// max ts is NOW - 5*60_000 = NOW - 300_000 → 300s
		expect(r.age_s).toBe(300);
		expect(r.mtime_ms).toBeGreaterThan(0);
	});
	test('shadow_blocks reads file mtime', () => {
		const r = qDataFreshness(db, { source: 'shadow_blocks' }, { paths: { shadowPath } });
		expect(r.age_s).toBeGreaterThanOrEqual(0);
		expect(r.mtime_ms).toBeGreaterThan(0);
	});
	test('unknown source throws', () => {
		expect(() => qDataFreshness(db, { source: 'bogus' }, { paths: { shadowPath } })).toThrow(/source/);
	});
});

describe('dispatchQuestion', () => {
	test('routes by name', async () => {
		const r = await dispatchQuestion({ name: 'liquidatable', params: { addr: ADDR_A }, db, shadowPath });
		expect(r.liquidatable).toBe(true);
	});
	test('unknown name throws with hint', async () => {
		await expect(dispatchQuestion({ name: 'no-such', params: {}, db, shadowPath }))
			.rejects.toThrow(/Available/);
	});
	test('registry exposes 8 questions', () => {
		expect(Object.keys(QUESTION_REGISTRY).sort()).toEqual([
			'at-risk-count',
			'builder-bid',
			'builder-share',
			'cheapest-flashloan',
			'data-freshness',
			'liquidatable',
			'recent-liquidations',
			'top-builder'
		]);
	});
});
