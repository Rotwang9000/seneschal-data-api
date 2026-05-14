// Integration tests for the Fastify REST server. We pass a fixture DB
// and fixture file paths via `buildApp`'s options so we never touch the
// live data sources. `fastify.inject` is used in place of a real HTTP
// socket (faster + deterministic).

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTestDb } from '../src/db.js';
import { buildApp } from '../src/rest-server.js';
import { _resetLeaderboardCacheForTest } from '../src/queries.js';

const ADDR_A = '0x' + 'a'.repeat(40);
const ADDR_B = '0x' + 'b'.repeat(40);

let app;
let db;
let tmpRoot;
let sparkPath;
let shadowPath;
let morphoPath;

beforeAll(async () => {
	db = openTestDb();

	const ins = db.prepare(`
		INSERT INTO borrower_snapshots
			(borrower_address, last_seen_ts, block_number, health_factor,
			 total_collateral_usd, total_debt_usd, liquidatable)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`);
	ins.run(ADDR_A, 1_700_000_001_000, 25_000_000, 0.99, 100000, 99000, 1);
	ins.run(ADDR_B, 1_700_000_002_000, 25_000_001, 1.05, 50000, 47000, 0);

	const insHist = db.prepare(`
		INSERT INTO aave_borrower_history
			(timestamp, block_number, borrower_address, health_factor,
			 total_collateral_usd, total_debt_usd, liquidatable)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`);
	for (let i = 0; i < 3; i++) {
		insHist.run(1_700_000_000_000 + i * 3_600_000, 25_000_000 + i, ADDR_A, 1.5 - i * 0.2, 100000, 99000, 0);
	}

	tmpRoot = join(tmpdir(), `seneschal-rest-test-${Date.now()}-${process.pid}`);
	mkdirSync(tmpRoot, { recursive: true });
	sparkPath = join(tmpRoot, 'spark.json');
	morphoPath = join(tmpRoot, 'morpho.json');
	shadowPath = join(tmpRoot, 'shadow.jsonl');

	writeFileSync(sparkPath, JSON.stringify({
		savedAt: new Date(1_700_000_100_000).toISOString(),
		count: 1,
		borrowers: [ADDR_A]
	}));
	writeFileSync(morphoPath, JSON.stringify({ lastUpdate: 1, chainId: 1, borrowers: {} }));
	const now = Date.now();
	writeFileSync(shadowPath, [
		JSON.stringify({ ts_ms: now - 1800_000, extra_data: 'beaverbuild.org', actual_total_wei: '50000000000000000' }),
		JSON.stringify({ ts_ms: now - 1200_000, extra_data: 'Seneschal/0.1', actual_total_wei: '20000000000000000' })
	].join('\n') + '\n');

	_resetLeaderboardCacheForTest();
	app = await buildApp({
		db,
		sparkPath,
		morphoPath,
		shadowPath,
		leaderboardTtlMs: 50,
		rateLimit: false,
		logger: false
	});
});

afterAll(async () => {
	await app?.close?.();
	db?.close?.();
	if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

async function call(method, url) {
	return app.inject({ method, url });
}

describe('routing & shape', () => {
	test('GET / returns service descriptor', async () => {
		const r = await call('GET', '/');
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.service).toMatch(/seneschal/i);
		expect(body.endpoints.length).toBeGreaterThan(0);
	});

	test('GET /v1/health is 200 with table sizes', async () => {
		const r = await call('GET', '/v1/health');
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.status).toBe('ok');
		expect(body.tables.borrower_snapshots).toBe(2);
	});

	test('unknown route is 404', async () => {
		const r = await call('GET', '/v1/banana');
		expect(r.statusCode).toBe(404);
		expect(r.json().error.code).toBe('not_found');
	});
});

describe('/v1/liquidations/atrisk', () => {
	test('returns at-risk borrowers under HF cap', async () => {
		const r = await call('GET', '/v1/liquidations/atrisk?max_hf=1.1');
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.results.length).toBe(2);
		expect(body.results.every(b => b.health_factor < 1.1)).toBe(true);
	});

	test('rejects negative max_hf as 400', async () => {
		const r = await call('GET', '/v1/liquidations/atrisk?max_hf=-1');
		expect(r.statusCode).toBe(400);
		expect(r.json().error.code).toBe('invalid_request');
	});

	test('rejects unknown protocol as 400', async () => {
		const r = await call('GET', '/v1/liquidations/atrisk?protocol=uniswap');
		expect(r.statusCode).toBe(400);
	});
});

describe('/v1/borrowers/:address', () => {
	test('returns combined borrower snapshot', async () => {
		const r = await call('GET', `/v1/borrowers/${ADDR_A}`);
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.found_in).toContain('aave');
		expect(body.aave.health_factor).toBeCloseTo(0.99);
	});

	test('rejects malformed addresses as 400', async () => {
		const r = await call('GET', '/v1/borrowers/0xnotanaddress');
		expect(r.statusCode).toBe(400);
	});

	test('returns empty result for unknown address (200)', async () => {
		const r = await call('GET', `/v1/borrowers/0x${'f'.repeat(40)}`);
		expect(r.statusCode).toBe(200);
		expect(r.json().found_in).toEqual([]);
	});
});

describe('/v1/borrowers/:address/history', () => {
	test('returns aave history series', async () => {
		const r = await call(
			'GET',
			`/v1/borrowers/${ADDR_A}/history?protocol=aave&since_ms=1700000000000&until_ms=1700010000000`
		);
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.points.length).toBe(3);
		expect(body.points[0].health_factor).toBeCloseTo(1.5);
	});

	test('rejects history for spark with 400', async () => {
		const r = await call('GET', `/v1/borrowers/${ADDR_A}/history?protocol=spark`);
		expect(r.statusCode).toBe(400);
	});
});

describe('/v1/builders/leaderboard', () => {
	test('returns aggregated leaderboard from fixture jsonl', async () => {
		_resetLeaderboardCacheForTest();
		const r = await call('GET', '/v1/builders/leaderboard');
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.total_slots).toBe(2);
		const names = body.builders.map(b => b.builder).sort();
		expect(names).toEqual(['beaverbuild', 'seneschal']);
	});
});

describe('CORS headers', () => {
	test('OPTIONS preflight returns CORS headers', async () => {
		const r = await app.inject({
			method: 'OPTIONS',
			url: '/v1/health',
			headers: { origin: 'https://example.com', 'access-control-request-method': 'GET' }
		});
		expect(r.statusCode).toBeLessThan(300);
		expect(r.headers['access-control-allow-origin']).toBeDefined();
	});
});

describe('/v1/borrowers (generic)', () => {
	test('returns pageable list', async () => {
		const r = await call('GET', '/v1/borrowers?limit=10&min_hf=0.5');
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(Array.isArray(body.results)).toBe(true);
		expect(typeof body.total_matched).toBe('number');
		expect(typeof body.has_more).toBe('boolean');
	});

	test('rejects malformed sort_by as 400', async () => {
		const r = await call('GET', '/v1/borrowers?sort_by=lol');
		expect(r.statusCode).toBe(400);
	});

	test('respects sort_dir=desc on debt_usd', async () => {
		const r = await call('GET', '/v1/borrowers?sort_by=debt_usd&sort_dir=desc');
		expect(r.statusCode).toBe(200);
	});
});

describe('/v1/flashloan/providers', () => {
	test('default returns ethereum catalogue', async () => {
		const r = await call('GET', '/v1/flashloan/providers');
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.providers.length).toBeGreaterThanOrEqual(4);
		expect(body.providers.some(p => p.id === 'flashbank')).toBe(true);
		expect(body.providers.some(p => p.id === 'aave-v3')).toBe(true);
	});

	test('max_fee_bps filters expensive providers', async () => {
		const r = await call('GET', '/v1/flashloan/providers?max_fee_bps=0');
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.providers.every(p => p.fee_bps === 0)).toBe(true);
		expect(body.providers.length).toBeGreaterThan(0);
	});

	test('multi_asset=true filters to multi-asset providers', async () => {
		const r = await call('GET', '/v1/flashloan/providers?multi_asset=true');
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.providers.every(p => p.supports_multi_asset)).toBe(true);
	});
});
