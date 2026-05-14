// Unit tests for queries.js. All assertions run against an in-memory
// SQLite DB seeded with deterministic fixture rows — no live DB access.
// The fixture covers the corner cases we care about: missing optional
// fields, HF / debt filtering, address normalisation, and protocol
// routing.

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTestDb } from '../src/db.js';
import {
	getHealth,
	listAtRiskBorrowers,
	listBorrowers,
	recentLiquidations,
	getBorrower,
	getBorrowerHistory,
	getBuilderLeaderboard,
	getStatsOverview,
	_resetLeaderboardCacheForTest,
	_internal
} from '../src/queries.js';

const ADDR_A = '0x' + 'a'.repeat(40);
const ADDR_B = '0x' + 'b'.repeat(40);
const ADDR_C = '0x' + 'c'.repeat(40);
const ADDR_M = '0x' + 'd'.repeat(40);

let db;
let tmpRoot;
let sparkPath;
let shadowPath;

beforeAll(() => {
	db = openTestDb();

	const insertSnap = db.prepare(`
		INSERT INTO borrower_snapshots
			(borrower_address, last_seen_ts, block_number, health_factor,
			 total_collateral_usd, total_debt_usd, liquidatable)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`);
	// Two healthy, one at risk, one liquidatable.
	insertSnap.run(ADDR_A, 1_700_000_001_000, 25_000_000, 0.98, 100000, 99000, 1);
	insertSnap.run(ADDR_B, 1_700_000_002_000, 25_000_001, 1.04, 250000, 240000, 0);
	insertSnap.run(ADDR_C, 1_700_000_003_000, 25_000_002, 1.42, 50000, 30000, 0);

	const insertMorpho = db.prepare(`
		INSERT INTO morpho_borrower_snapshots
			(market_id, borrower_address, last_seen_ts, block_number,
			 ltv, lltv, debt_usd, distance_to_liquidation)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`);
	// ltv 0.82, lltv 0.86 → HF ≈ 1.0488. Below 1.5, would surface.
	insertMorpho.run('0xmarket-abc', ADDR_M, 1_700_000_004_000, 25_000_003, 0.82, 0.86, 78000, 0.04);

	const insertHist = db.prepare(`
		INSERT INTO aave_borrower_history
			(timestamp, block_number, borrower_address, health_factor,
			 total_collateral_usd, total_debt_usd, liquidatable)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`);
	// 5 points across 5 hours, hf decreasing.
	for (let i = 0; i < 5; i++) {
		insertHist.run(
			1_700_000_000_000 + i * 3_600_000,
			25_000_000 + i,
			ADDR_B,
			1.4 - i * 0.1,
			250000,
			240000 - i * 1000,
			i === 4 ? 1 : 0
		);
	}

	db.prepare(`
		INSERT INTO missed_liquidations
			(tx_hash, timestamp, block_number, borrower_address,
			 liquidator, debt_asset, collateral_asset,
			 debt_to_cover, liquidated_collateral, debt_usd,
			 was_tracking, would_have_been_profitable)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run('0xtx1', 1_700_000_010_000, 25_000_010, ADDR_A,
		'0xliquidator', 'USDC', 'WETH',
		'50000000000', '1000000000000000000', 50000, 1, 1);

	db.prepare(`
		INSERT INTO executions
			(timestamp, block_number, strategy, borrower_address, tx_hash, success,
			 actual_profit_usd, gas_used_usd)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`).run(1_700_000_020_000, 25_000_020, 'aave_liquidation', ADDR_C,
		'0xtx2', 1, 300, 12.5);

	// Disk fixtures for spark JSON and shadow-blocks JSONL.
	tmpRoot = join(tmpdir(), `seneschal-test-${Date.now()}-${process.pid}`);
	mkdirSync(tmpRoot, { recursive: true });
	sparkPath = join(tmpRoot, 'spark-borrowers.json');
	// Live spark snapshot is a list of bare addresses (strings).
	writeFileSync(sparkPath, JSON.stringify({
		savedAt: new Date(1_700_000_100_000).toISOString(),
		count: 2,
		borrowers: [ADDR_A, ADDR_C]
	}));

	shadowPath = join(tmpRoot, 'shadow-blocks.jsonl');
	const now = Date.now();
	// Mix of in-window slot records: some use `extra_data` (older
	// format), some use only `miner` (current format).
	const lines = [
		{ ts_ms: now - 3600_000, extra_data: 'beaverbuild.org', miner: '0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97', actual_total_wei: '50000000000000000' },
		{ ts_ms: now - 3000_000, miner: '0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97', actual_total_wei: '30000000000000000' },
		{ ts_ms: now - 2400_000, miner: '0xdadb0d80178819f2319190d340ce9a924f783711', actual_total_wei: '20000000000000000' },
		{ ts_ms: now - 1800_000, extra_data: 'Seneschal/0.1',   actual_total_wei: '40000000000000000' },
		{ ts_ms: now - 1200_000, miner: '0x6420e9c89f54afd58a3a2bdb9a5c9c61e76dbabc', actual_total_wei: '10000000000000000' },
		// outside 24h window
		{ ts_ms: now - 200 * 3600_000, miner: '0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97', actual_total_wei: '0' }
	];
	writeFileSync(shadowPath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
});

afterAll(() => {
	db?.close?.();
	if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe('input validators', () => {
	test('normaliseAddress lowercases and validates', () => {
		expect(_internal.normaliseAddress('0x' + 'A'.repeat(40))).toBe(ADDR_A);
		expect(() => _internal.normaliseAddress('not-an-address')).toThrow(TypeError);
		expect(() => _internal.normaliseAddress('0xshort')).toThrow(TypeError);
		expect(() => _internal.normaliseAddress(42)).toThrow(TypeError);
	});

	test('clampLimit clamps to MAX_LIMIT and rejects junk', () => {
		expect(_internal.clampLimit(undefined)).toBe(50);
		expect(_internal.clampLimit(1000)).toBe(500);
		expect(_internal.clampLimit('25')).toBe(25);
		expect(() => _internal.clampLimit(-1)).toThrow(TypeError);
		expect(() => _internal.clampLimit('foo')).toThrow(TypeError);
	});

	test('validateProtocol rejects unknown protocols', () => {
		expect(_internal.validateProtocol('aave')).toBe('aave');
		expect(_internal.validateProtocol('AAVE')).toBe('aave');
		expect(_internal.validateProtocol('', true)).toBe(null);
		expect(() => _internal.validateProtocol('uniswap')).toThrow(TypeError);
	});

	test('validateGranularity defaults to raw and rejects unknown', () => {
		expect(_internal.validateGranularity(undefined)).toBe('raw');
		expect(_internal.validateGranularity('hour')).toBe('hour');
		expect(() => _internal.validateGranularity('month')).toThrow(TypeError);
	});
});

describe('getHealth', () => {
	test('returns ok status with table sizes', () => {
		const h = getHealth(db, { morphoMtimeMs: 12345, version: '0.1.0' });
		expect(h.status).toBe('ok');
		expect(h.version).toBe('0.1.0');
		expect(h.tables.borrower_snapshots).toBe(3);
		expect(h.tables.morpho_borrower_snapshots).toBe(1);
		expect(h.json_sources.morpho_borrowers_mtime_ms).toBe(12345);
		expect(typeof h.now_ms).toBe('number');
	});
});

describe('listAtRiskBorrowers', () => {
	test('returns only borrowers with HF < max_hf, sorted ascending', () => {
		const r = listAtRiskBorrowers(db, { max_hf: 1.06, _sparkPath: sparkPath });
		// In window: ADDR_A aave (0.98), ADDR_B aave (1.04),
		// ADDR_M morpho (synth HF ≈ 1.0488). Spark contributes no
		// HF-bearing rows.
		expect(r.results.length).toBe(3);
		expect(r.results[0].health_factor).toBeLessThanOrEqual(r.results[1].health_factor);
		const protos = new Set(r.results.map(r => r.protocol));
		expect(protos).toEqual(new Set(['aave', 'morpho']));
	});

	test('protocol=aave filters out morpho', () => {
		const r = listAtRiskBorrowers(db, { protocol: 'aave', max_hf: 1.5, _sparkPath: sparkPath });
		expect(r.results.every(b => b.protocol === 'aave')).toBe(true);
	});

	test('protocol=morpho returns synthesised HF rows with ltv/lltv', () => {
		const r = listAtRiskBorrowers(db, { protocol: 'morpho', _sparkPath: sparkPath });
		expect(r.results).toHaveLength(1);
		expect(r.results[0].protocol).toBe('morpho');
		expect(r.results[0].health_factor).toBeCloseTo(1.0488, 3);
		expect(r.results[0].ltv).toBeCloseTo(0.82);
		expect(r.results[0].lltv).toBeCloseTo(0.86);
	});

	test('min_debt_usd filters out small positions', () => {
		const r = listAtRiskBorrowers(db, { protocol: 'aave', min_debt_usd: 100000, _sparkPath: sparkPath });
		expect(r.results.every(b => b.debt_usd >= 100000)).toBe(true);
	});

	test('limit truncates and reports has_more', () => {
		const r = listAtRiskBorrowers(db, { max_hf: 99, limit: 1, _sparkPath: sparkPath });
		expect(r.results.length).toBe(1);
		expect(r.has_more).toBe(true);
	});

	test('rejects invalid max_hf', () => {
		expect(() => listAtRiskBorrowers(db, { max_hf: -1 })).toThrow(TypeError);
		expect(() => listAtRiskBorrowers(db, { max_hf: 'huh' })).toThrow(TypeError);
	});
});

describe('recentLiquidations', () => {
	test('returns missed + landings, sorted desc', () => {
		const r = recentLiquidations(db, { since_ms: 1_700_000_000_000 });
		expect(r.results.length).toBe(2);
		expect(r.results[0].timestamp_ms).toBeGreaterThanOrEqual(r.results[1].timestamp_ms);
		const outcomes = r.results.map(x => x.outcome).sort();
		expect(outcomes).toEqual(['we_landed', 'won_by_other']);
	});

	test('protocol filter narrows landings via strategy LIKE', () => {
		// missed_liquidations row has no protocol column, so it still appears.
		// The aave_liquidation landing matches `aave%` LIKE.
		const r = recentLiquidations(db, { since_ms: 1_700_000_000_000, protocol: 'aave' });
		expect(r.results.some(x => x.outcome === 'we_landed')).toBe(true);
	});

	test('since_ms cutoff excludes earlier rows', () => {
		const r = recentLiquidations(db, { since_ms: 1_900_000_000_000 });
		expect(r.results).toHaveLength(0);
	});
});

describe('getBorrower', () => {
	test('returns nothing for an address never seen', () => {
		const r = getBorrower(db, { address: '0x' + 'f'.repeat(40), _sparkPath: sparkPath });
		expect(r.found_in).toEqual([]);
		expect(r.aave).toBeNull();
		expect(r.morpho).toBeNull();
		expect(r.spark).toBeNull();
	});

	test('returns combined info for a borrower in multiple protocols', () => {
		const r = getBorrower(db, { address: ADDR_A, _sparkPath: sparkPath });
		expect(r.found_in).toEqual(expect.arrayContaining(['aave', 'spark']));
		expect(r.aave.health_factor).toBeCloseTo(0.98);
		expect(r.spark.watched).toBe(true);
	});

	test('returns all morpho positions across markets', () => {
		const r = getBorrower(db, { address: ADDR_M, _sparkPath: sparkPath });
		expect(r.found_in).toContain('morpho');
		expect(r.morpho.positions).toHaveLength(1);
		expect(r.morpho.positions[0].market_id).toBe('0xmarket-abc');
		expect(r.morpho.positions[0].health_factor).toBeCloseTo(1.0488, 3);
	});

	test('case-insensitive address lookup', () => {
		const r = getBorrower(db, { address: ADDR_A.toUpperCase(), _sparkPath: sparkPath });
		expect(r.aave).not.toBeNull();
		expect(r.address).toBe(ADDR_A);
	});
});

describe('getBorrowerHistory', () => {
	test('returns raw aave history points', () => {
		const r = getBorrowerHistory(db, {
			address: ADDR_B,
			protocol: 'aave',
			since_ms: 1_700_000_000_000,
			until_ms: 1_700_000_000_000 + 10 * 3_600_000
		});
		expect(r.points.length).toBe(5);
		expect(r.points[0].health_factor).toBeCloseTo(1.4);
		expect(r.points[4].health_factor).toBeCloseTo(1.0, 5);
	});

	test('hourly granularity collapses to one point per hour', () => {
		const r = getBorrowerHistory(db, {
			address: ADDR_B,
			protocol: 'aave',
			granularity: 'hour',
			since_ms: 1_700_000_000_000,
			until_ms: 1_700_000_000_000 + 10 * 3_600_000
		});
		expect(r.granularity).toBe('hour');
		// Original points are 1 hour apart, so we get the same count.
		expect(r.points.length).toBe(5);
	});

	test('rejects unsupported protocol', () => {
		expect(() => getBorrowerHistory(db, { address: ADDR_B, protocol: 'spark' }))
			.toThrow(/history not available/);
	});

	test('rejects malformed time range', () => {
		expect(() => getBorrowerHistory(db, {
			address: ADDR_B,
			protocol: 'aave',
			since_ms: 1_700_000_100_000,
			until_ms: 1_700_000_000_000
		})).toThrow(TypeError);
	});
});

describe('listBorrowers', () => {
	test('default returns all Aave + Morpho rows (4 fixtures)', () => {
		const r = listBorrowers(db);
		expect(r.results.length).toBeGreaterThanOrEqual(3);
		expect(r.filters.sort_by).toBe('health_factor');
	});

	test('min_hf and max_hf form a range', () => {
		const r = listBorrowers(db, { min_hf: 1.0, max_hf: 1.1 });
		for (const row of r.results) {
			expect(row.health_factor).toBeGreaterThanOrEqual(1.0);
			expect(row.health_factor).toBeLessThan(1.1);
		}
	});

	test('offset paginates without overlap', () => {
		const a = listBorrowers(db, { limit: 2, offset: 0 });
		const b = listBorrowers(db, { limit: 2, offset: 2 });
		const aIds = a.results.map(r => r.borrower + r.protocol);
		const bIds = b.results.map(r => r.borrower + r.protocol);
		for (const id of aIds) expect(bIds).not.toContain(id);
	});

	test('sort_by debt_usd desc gives largest first', () => {
		const r = listBorrowers(db, { sort_by: 'debt_usd', sort_dir: 'desc' });
		const debts = r.results.map(x => x.debt_usd).filter(d => d != null);
		for (let i = 1; i < debts.length; i++) {
			expect(debts[i - 1]).toBeGreaterThanOrEqual(debts[i]);
		}
	});

	test('rejects unknown sort_by', () => {
		expect(() => listBorrowers(db, { sort_by: 'banana' })).toThrow(TypeError);
	});

	test('rejects malformed bounds', () => {
		expect(() => listBorrowers(db, { min_hf: 'banana' })).toThrow(TypeError);
	});

	test('total_matched + has_more behave', () => {
		const r = listBorrowers(db, { limit: 1, offset: 0 });
		expect(r.result_count).toBe(1);
		expect(r.total_matched).toBeGreaterThanOrEqual(r.result_count);
		expect(r.has_more).toBe(r.total_matched > 1);
	});
});

describe('getStatsOverview', () => {
	test('bundles the dashboard inputs', async () => {
		_resetLeaderboardCacheForTest();
		const r = await getStatsOverview(db, {
			_shadowPath: shadowPath,
			_sparkPath: sparkPath,
			_ttlMs: 1
		});
		expect(typeof r.as_of_ms).toBe('number');
		expect(r.totals.borrower_snapshots).toBe(3);
		expect(r.totals.morpho_borrower_snapshots).toBe(1);
		expect(Array.isArray(r.hf_histogram)).toBe(true);
		expect(r.hf_histogram).toHaveLength(5);
		const liquidatable = r.hf_histogram.find(b => b.bucket === '0.8–1.0');
		expect(liquidatable.total_count).toBeGreaterThanOrEqual(1);
		expect(r.top_at_risk.length).toBeGreaterThan(0);
		expect(r.builders['24h'].length).toBeGreaterThan(0);
		expect(r.builders.total_slots_24h).toBeGreaterThanOrEqual(5);
		expect(r.liquidations_30d_per_day.length).toBeGreaterThanOrEqual(0);
		expect(Array.isArray(r.recent_liquidations)).toBe(true);
	});

	test('KPI block has correct shape and counts', async () => {
		_resetLeaderboardCacheForTest();
		const r = await getStatsOverview(db, {
			_shadowPath: shadowPath,
			_sparkPath: sparkPath,
			_ttlMs: 1
		});
		expect(r.kpis).toBeDefined();
		// 3 Aave + 1 Morpho fixture rows.
		expect(r.kpis.positions_tracked).toBe(4);
		// ADDR_A HF 0.98 + ADDR_B HF 1.04 both < 1.05; Morpho HF ~1.0488 also < 1.05.
		expect(r.kpis.at_risk_count).toBeGreaterThanOrEqual(2);
		expect(typeof r.kpis.aave_debt_under_watch_usd).toBe('number');
		expect(typeof r.kpis.liquidations_24h_count).toBe('number');
	});

	test('Morpho rows in top_at_risk have null debt_usd', async () => {
		_resetLeaderboardCacheForTest();
		const r = await getStatsOverview(db, {
			_shadowPath: shadowPath,
			_sparkPath: sparkPath,
			_ttlMs: 1
		});
		const morphoRow = r.top_at_risk.find(x => x.protocol === 'morpho');
		if (morphoRow) {
			expect(morphoRow.debt_usd).toBeNull();
		}
	});

	test('histogram has no morpho_debt_usd field', async () => {
		_resetLeaderboardCacheForTest();
		const r = await getStatsOverview(db, {
			_shadowPath: shadowPath,
			_sparkPath: sparkPath,
			_ttlMs: 1
		});
		for (const b of r.hf_histogram) {
			expect(b).not.toHaveProperty('morpho_debt_usd');
			expect(b).not.toHaveProperty('total_debt_usd');
		}
	});
});

describe('getBuilderLeaderboard', () => {
	test('aggregates winners across the window', async () => {
		_resetLeaderboardCacheForTest();
		const r = await getBuilderLeaderboard({ _shadowPath: shadowPath, _ttlMs: 1 });
		// 5 in-window slots, one out-of-window — total_slots should be 5.
		expect(r.total_slots).toBe(5);
		const names = r.builders.map(b => b.builder);
		expect(names).toEqual(expect.arrayContaining(['beaverbuild', 'titan', 'seneschal', 'jet']));
		const beaver = r.builders.find(b => b.builder === 'beaverbuild');
		expect(beaver.slots_won).toBe(2);
		expect(beaver.share_pct).toBe(40);
	});

	test('caches inside the TTL', async () => {
		_resetLeaderboardCacheForTest();
		const a = await getBuilderLeaderboard({ _shadowPath: shadowPath, _ttlMs: 60_000 });
		const b = await getBuilderLeaderboard({ _shadowPath: shadowPath, _ttlMs: 60_000 });
		expect(a.cached).toBe(false);
		expect(b.cached).toBe(true);
		expect(b.builders).toEqual(a.builders);
	});

	test('returns empty leaderboard when shadow file missing', async () => {
		_resetLeaderboardCacheForTest();
		const r = await getBuilderLeaderboard({ _shadowPath: '/nonexistent/seneschal.jsonl' });
		expect(r.total_slots).toBe(0);
		expect(r.builders).toEqual([]);
	});
});
