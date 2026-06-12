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
		logger: false,
		// Disable income RPC reads in unit tests — those are exercised
		// against fake balances in income.test.js + a dedicated mocked
		// suite below.
		incomeCfg: { enabled: false, reason: 'disabled-in-tests' }
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

	// Agent crawlers fetch these from the API origin (not the docs
	// host); a 404 here loses the listing.
	test('GET /llms.txt serves the agent-facing service summary', async () => {
		const r = await call('GET', '/llms.txt');
		expect(r.statusCode).toBe(200);
		expect(r.headers['content-type']).toMatch(/text\/plain/);
		expect(r.body).toMatch(/Seneschal/);
		expect(r.body).toMatch(/openapi\.json/);
	});

	test('GET /favicon.ico serves an icon', async () => {
		const r = await call('GET', '/favicon.ico');
		expect(r.statusCode).toBe(200);
		expect(r.headers['content-type']).toMatch(/image\/x-icon/);
	});
});

describe('/v1/ops/health (watchdog state surface)', () => {
	// We rebuild a tiny one-off app for each scenario so the
	// shared `app` (set in beforeAll) stays untouched. The
	// endpoint reads the state file path from
	// `options.opsStateFile`, so we can point it at fixtures
	// without env mutation.
	async function buildWithStateFile(pathOrNull) {
		return buildApp({
			db,
			sparkPath,
			morphoPath,
			shadowPath,
			leaderboardTtlMs: 50,
			rateLimit: false,
			logger: false,
			incomeCfg: { enabled: false, reason: 'disabled-in-tests' },
			opsStateFile: pathOrNull
		});
	}

	test('missing state file → 503 overall=unknown', async () => {
		const a = await buildWithStateFile(join(tmpRoot, 'no-such-file.json'));
		try {
			const r = await a.inject({ method: 'GET', url: '/v1/ops/health' });
			expect(r.statusCode).toBe(503);
			expect(r.json().overall).toBe('unknown');
			expect(r.json().reason).toMatch(/no watchdog state/);
		}
		finally { await a.close(); }
	});

	test('fresh ok state → 200', async () => {
		const fp = join(tmpRoot, 'ops-ok.json');
		writeFileSync(fp, JSON.stringify({
			overall: 'ok',
			summary: 'OK · 5 units + 4 scripts healthy',
			generatedAtMs: Date.now(),
			units: { 'seneschal-data-rest.service': { status: 'ok' } },
			scripts: { '/opt/x.mjs': { status: 'ok' } }
		}));
		const a = await buildWithStateFile(fp);
		try {
			const r = await a.inject({ method: 'GET', url: '/v1/ops/health' });
			expect(r.statusCode).toBe(200);
			expect(r.json().overall).toBe('ok');
			expect(r.json().ageMs).toBeGreaterThanOrEqual(0);
		}
		finally { await a.close(); }
	});

	test('fresh degraded state → 503 overall=degraded', async () => {
		const fp = join(tmpRoot, 'ops-bad.json');
		writeFileSync(fp, JSON.stringify({
			overall: 'degraded',
			summary: 'DEGRADED · 1 failed (x)',
			generatedAtMs: Date.now(),
			units: { 'x': { status: 'failed', reason: 'boom' } },
			scripts: {}
		}));
		const a = await buildWithStateFile(fp);
		try {
			const r = await a.inject({ method: 'GET', url: '/v1/ops/health' });
			expect(r.statusCode).toBe(503);
			expect(r.json().overall).toBe('degraded');
			expect(r.json().units.x.status).toBe('failed');
		}
		finally { await a.close(); }
	});

	test('stale state file → 503 overall=stale', async () => {
		const fp = join(tmpRoot, 'ops-stale.json');
		writeFileSync(fp, JSON.stringify({
			overall: 'ok',
			summary: 'OK',
			generatedAtMs: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
			units: {},
			scripts: {}
		}));
		const a = await buildWithStateFile(fp);
		try {
			const r = await a.inject({ method: 'GET', url: '/v1/ops/health' });
			expect(r.statusCode).toBe(503);
			expect(r.json().overall).toBe('stale');
			expect(r.json().reason).toMatch(/min old/);
		}
		finally { await a.close(); }
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

	test('OPTIONS preflight for POST endpoint advertises POST + content-type', async () => {
		// docs.seneschal.space embeds an in-page derive-viewkey form
		// that POSTs cross-origin. Without POST in allow-methods (and
		// content-type in allow-headers) browsers reject the request
		// at the preflight stage, never reaching server-side
		// validation. Lock the methods + headers list against
		// regressions.
		const r = await app.inject({
			method: 'OPTIONS',
			url: '/v1/private/derive-viewkey',
			headers: {
				origin: 'https://docs.seneschal.space',
				'access-control-request-method': 'POST',
				'access-control-request-headers': 'content-type'
			}
		});
		expect(r.statusCode).toBeLessThan(300);
		const allowMethods = r.headers['access-control-allow-methods'] ?? '';
		expect(allowMethods).toMatch(/POST/);
		const allowHeaders = r.headers['access-control-allow-headers'] ?? '';
		expect(allowHeaders).toMatch(/content-type/i);
	});

	test('exposes the payment-required header so browsers can read x402 challenges', async () => {
		// The panel.seneschal.space WalletConnect UI is a browser
		// client. It cannot read response headers cross-origin unless
		// the server explicitly lists them in `access-control-expose-
		// headers`. The base64-encoded x402 challenge ships in
		// `payment-required` — without exposure the browser cannot
		// build the signed payment payload and the entire panel breaks.
		const r = await app.inject({
			method: 'OPTIONS',
			url: '/v1/private/topup',
			headers: {
				origin: 'https://panel.seneschal.space',
				'access-control-request-method': 'POST',
				'access-control-request-headers': 'content-type, x-payment'
			}
		});
		const exposed = r.headers['access-control-expose-headers'] ?? '';
		expect(exposed).toMatch(/payment-required/i);
		expect(exposed).toMatch(/x-payment-response/i);
		// Lock DELETE in for the watch-cancel route.
		const methods = r.headers['access-control-allow-methods'] ?? '';
		expect(methods).toMatch(/DELETE/);
	});
});

describe('error handler — status-code pass-through', () => {
	// The error handler must NOT collapse 429 (rate limit) and other
	// 4xx codes thrown by plugins into 500. Regression: in May 2026
	// @fastify/rate-limit fired against derive-viewkey and the global
	// handler returned 500 because it only special-cased TypeError +
	// statusCode === 400. Production users saw "internal error"
	// instead of a Retry-After / 429.
	let errApp;
	beforeAll(async () => {
		errApp = await buildApp({
			db,
			sparkPath,
			morphoPath,
			shadowPath,
			leaderboardTtlMs: 50,
			rateLimit: false,
			logger: false,
			incomeCfg: { enabled: false, reason: 'disabled-in-tests' }
		});
		errApp.get('/__throw429', async () => {
			const e = new Error('Rate limit exceeded, retry in 1 minute');
			e.statusCode = 429;
			throw e;
		});
		errApp.get('/__throw401', async () => {
			const e = new Error('forbidden test');
			e.statusCode = 401;
			e.code = 'unauthorized';
			throw e;
		});
		errApp.get('/__throw500', async () => { throw new Error('boom'); });
	});
	afterAll(async () => { await errApp?.close?.(); });

	test('preserves 429 from a thrown error and adds retry-after', async () => {
		const r = await errApp.inject({ method: 'GET', url: '/__throw429' });
		expect(r.statusCode).toBe(429);
		expect(r.headers['retry-after']).toBe('60');
		const body = r.json();
		expect(body.error.code).toBe('rate_limited');
		expect(body.error.message).toMatch(/rate limit/i);
	});

	test('preserves other 4xx status codes with their code label', async () => {
		const r = await errApp.inject({ method: 'GET', url: '/__throw401' });
		expect(r.statusCode).toBe(401);
		expect(r.json().error.code).toBe('unauthorized');
	});

	test('unrecognised errors still collapse to 500 / internal_error', async () => {
		const r = await errApp.inject({ method: 'GET', url: '/__throw500' });
		expect(r.statusCode).toBe(500);
		expect(r.json().error.code).toBe('internal_error');
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

describe('paywall surface (x402 disabled)', () => {
	test('GET /v1/paywall returns disabled state', async () => {
		const r = await call('GET', '/v1/paywall');
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.enabled).toBe(false);
		expect(body.reason).toMatch(/RECIPIENT_ADDRESS/);
	});

	test('GET /.well-known/x402 returns 404 when paywall is off', async () => {
		const r = await call('GET', '/.well-known/x402');
		expect(r.statusCode).toBe(404);
		const body = r.json();
		expect(body.error.code).toBe('paywall_not_configured');
	});

	test('GET /v1/stats/income returns 503 when income disabled', async () => {
		const r = await call('GET', '/v1/stats/income');
		expect(r.statusCode).toBe(503);
		const body = r.json();
		expect(body.enabled).toBe(false);
		expect(body.reason).toMatch(/disabled-in-tests/);
	});

	test('GET / advertises paywall slot but resolves to null on free server', async () => {
		const r = await call('GET', '/');
		const body = r.json();
		expect(body).toHaveProperty('paywall');
		expect(body.paywall).toBeNull();
		expect(body.endpoints).toEqual(expect.arrayContaining([
			expect.stringMatching(/premium\/opportunities/)
		]));
	});

	test('GET /v1/premium/opportunities answers 503 with paywall_not_configured', async () => {
		const r = await call('GET', '/v1/premium/opportunities');
		expect(r.statusCode).toBe(503);
		const body = r.json();
		expect(body.error.code).toBe('paywall_not_configured');
		expect(body.error.message).toMatch(/X402_RECIPIENT_ADDRESS/);
	});

	test('GET /v1/premium/builder-stats answers 503 with paywall_not_configured', async () => {
		const r = await call('GET', '/v1/premium/builder-stats');
		expect(r.statusCode).toBe(503);
		const body = r.json();
		expect(body.error.code).toBe('paywall_not_configured');
	});
});

describe('paywall surface (x402 enabled, in-process)', () => {
	let appPaid;
	beforeAll(async () => {
		// Build a second app with x402 enabled but pointed at a
		// nonsense facilitator URL (we never call it — the unit
		// test exercises the route-not-paid path: an unsigned GET
		// triggers the middleware's 402 challenge entirely from
		// the local route config). `installX402: false` keeps the
		// dynamic @x402/fastify import out of the unit test for
		// speed; the in-process surface still describes the
		// configured paywall via /v1/paywall + /.
		appPaid = await buildApp({
			db,
			sparkPath,
			morphoPath,
			shadowPath,
			leaderboardTtlMs: 50,
			rateLimit: false,
			logger: false,
			installX402: false,
			incomeCfg: { enabled: false, reason: 'disabled-in-tests' },
			x402Cfg: {
				enabled: true,
				recipient: '0x1234567890abcdef1234567890abcdef12345678',
				network: 'eip155:8453',
				facilitatorUrl: 'https://x402.org/facilitator',
				routes: {
					'GET /v1/premium/opportunities': {
						accepts: {
							scheme: 'exact',
							payTo: '0x1234567890abcdef1234567890abcdef12345678',
							price: '$0.05',
							network: 'eip155:8453',
							maxTimeoutSeconds: 120
						},
						description: 'premium opportunity feed',
						mimeType: 'application/json'
					}
				}
			}
		});
	});

	afterAll(async () => {
		await appPaid?.close?.();
	});

	test('GET / surfaces paywall metadata', async () => {
		const r = await appPaid.inject({ method: 'GET', url: '/' });
		const body = r.json();
		expect(body.paywall).not.toBeNull();
		expect(body.paywall.protocol).toBe('x402');
		expect(body.paywall.payTo).toBe('0x1234567890abcdef1234567890abcdef12345678');
		expect(body.paywall.routes[0].endpoint).toBe('GET /v1/premium/opportunities');
		expect(body.paywall.routes[0].price).toBe('$0.05');
	});

	test('GET /v1/paywall mirrors the / paywall block', async () => {
		const r = await appPaid.inject({ method: 'GET', url: '/v1/paywall' });
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.protocol).toBe('x402');
		expect(body.routes.length).toBe(1);
	});

	test('GET /.well-known/x402 returns discovery manifest', async () => {
		const r = await appPaid.inject({ method: 'GET', url: '/.well-known/x402' });
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.protocol).toBe('x402');
		expect(body.payTo).toBe('0x1234567890abcdef1234567890abcdef12345678');
		expect(body.service).toBeDefined();
		expect(body.service.name).toMatch(/Seneschal/);
		expect(body.service.homepage).toBe('https://seneschal.space');
		expect(body.service.api_root).toBe('https://api.seneschal.space');
		// Discovery surface advertises the control panel + Telegram
		// contact (operator no longer monitors Discord) and lists the
		// flagship Private Watch product first.
		expect(body.service.control_panel).toBe('https://panel.seneschal.space');
		expect(body.service.contact).toBe('https://t.me/OrknetP');
		expect(Array.isArray(body.service.products)).toBe(true);
		expect(body.service.products[0].name).toBe('Private Watch');
		expect(body.service.products[0].start).toBe('POST /v1/private/watch');
		expect(body.routes.length).toBe(1);
	});

	test('GET /v1/premium/opportunities returns the feed when middleware not installed', async () => {
		// With installX402:false, the route handler runs without the
		// paywall enforcing 402 — but the feed itself still works,
		// which protects against regressions where the premium SQL
		// breaks regardless of the payment layer.
		const r = await appPaid.inject({ method: 'GET', url: '/v1/premium/opportunities?limit=5' });
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(Array.isArray(body.opportunities)).toBe(true);
		expect(body.assumptions.liquidation_bonus_default).toBeCloseTo(0.06);
	});

	test('GET /v1/premium/builder-stats returns the histogram when middleware not installed', async () => {
		const r = await appPaid.inject({ method: 'GET', url: '/v1/premium/builder-stats?window_ms=86400000' });
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.window_ms).toBe(24 * 60 * 60 * 1000);
		expect(Array.isArray(body.builders)).toBe(true);
		expect(Array.isArray(body.hourly_distribution)).toBe(true);
		expect(body.hourly_distribution).toHaveLength(24);
	});
});

describe('penny oracle — /v1/q/*', () => {
	test('GET /v1/q is free even without paywall — returns catalogue', async () => {
		const r = await app.inject({ method: 'GET', url: '/v1/q' });
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(Array.isArray(body.questions)).toBe(true);
		const names = body.questions.map(q => q.name).sort();
		expect(names).toContain('liquidatable');
		expect(names).toContain('top-builder');
		expect(names).toContain('data-freshness');
		expect(body.price_per_call).toBeNull(); // paywall off in this app
	});

	test('GET /v1/q/liquidatable 503s when paywall is off', async () => {
		const r = await app.inject({ method: 'GET', url: `/v1/q/liquidatable?addr=0x${'1'.repeat(40)}` });
		expect(r.statusCode).toBe(503);
		expect(r.json().error.code).toBe('paywall_not_configured');
	});
});

describe('penny oracle — paywall enabled', () => {
	let appPaid2;
	beforeAll(async () => {
		appPaid2 = await buildApp({
			db,
			sparkPath,
			morphoPath,
			shadowPath,
			leaderboardTtlMs: 50,
			rateLimit: false,
			logger: false,
			installX402: false,
			incomeCfg: { enabled: false, reason: 'disabled-in-tests' },
			x402Cfg: {
				enabled: true,
				recipient: '0x1234567890abcdef1234567890abcdef12345678',
				network: 'eip155:8453',
				facilitatorUrl: 'https://x402.org/facilitator',
				routes: {
					'GET /v1/q/liquidatable': {
						accepts: {
							scheme: 'exact',
							payTo: '0x1234567890abcdef1234567890abcdef12345678',
							price: '$0.001',
							network: 'eip155:8453',
							maxTimeoutSeconds: 120
						},
						description: 'q: liquidatable',
						mimeType: 'application/json'
					}
				}
			}
		});
	});
	afterAll(async () => { await appPaid2?.close?.(); });

	test('GET /v1/q returns price per call once paywall is set', async () => {
		const r = await appPaid2.inject({ method: 'GET', url: '/v1/q' });
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.price_per_call).toBe('$0.001');
		expect(body.network).toBe('eip155:8453');
	});

	test('GET /v1/q/liquidatable returns flat shape', async () => {
		// installX402:false means we skip the 402 challenge; the
		// handler runs, exercising the SQL + shape stability. ADDR_A
		// is the fixture's HF=0.99 liquidatable row.
		const r = await appPaid2.inject({ method: 'GET', url: `/v1/q/liquidatable?addr=${ADDR_A}` });
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.found).toBe(true);
		expect(typeof body.hf).toBe('number');
		expect(typeof body.debt_usd).toBe('number');
		expect(body.protocol).toBe('aave');
		expect(body.liquidatable).toBe(true);
		expect(typeof body.last_seen_ms).toBe('number');
	});

	test('GET /v1/q/at-risk-count answers default', async () => {
		const r = await appPaid2.inject({ method: 'GET', url: '/v1/q/at-risk-count' });
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(typeof body.count).toBe('number');
		expect(typeof body.total_debt_usd).toBe('number');
		expect(body.max_hf).toBe(1.05);
	});

	test('GET /v1/q/cheapest-flashloan returns provider', async () => {
		const r = await appPaid2.inject({ method: 'GET', url: '/v1/q/cheapest-flashloan?asset=WETH' });
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.found).toBe(true);
		expect(typeof body.provider).toBe('string');
		expect(typeof body.fee_bps).toBe('number');
	});

	test('GET /v1/q/data-freshness for borrower_snapshot', async () => {
		const r = await appPaid2.inject({ method: 'GET', url: '/v1/q/data-freshness?source=borrower_snapshot' });
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.source).toBe('borrower_snapshot');
		// `age_s` can be null only when the table is empty; the
		// fixture seeded rows so it must be numeric.
		expect(typeof body.age_s).toBe('number');
	});

	test('GET /v1/q/top-builder over 7d', async () => {
		const r = await appPaid2.inject({ method: 'GET', url: '/v1/q/top-builder?window=7d' });
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.window).toBe('7d');
		expect(typeof body.total_slots).toBe('number');
	});

	test('validation: malformed addr → 400', async () => {
		const r = await appPaid2.inject({ method: 'GET', url: '/v1/q/liquidatable?addr=nope' });
		expect(r.statusCode).toBe(400);
	});
});

describe('penny oracle — privacy-chain routes', () => {
	let appChain;
	const stubResults = {
		'get_info': { result: { height: 100, target_height: 0, synchronized: true, tx_pool_size: 7, top_block_hash: 'h' } },
		'get_fee_estimate': { result: { fee: 1234, quantization_mask: 10 } },
		'get_last_block_header': { result: { block_header: { height: 100, hash: 'h', timestamp: 1, difficulty: 2, block_size: 3 } } },
		'getblockchaininfo': { result: { blocks: 200, headers: 200, estimatedheight: 200, verificationprogress: 0.9999, bestblockhash: 'b', chain: 'main' } },
		'getmempoolinfo': { result: { size: 9, bytes: 1000 } },
		'getbestblockhash': { result: 'beef' },
		'getblockheader': { result: { height: 200, time: 1, difficulty: 1, size: 1 } }
	};
	const stubFetch = async (_url, opts) => {
		const body = JSON.parse(opts.body);
		if (stubResults[body.method]) {
			return { ok: true, status: 200, json: async () => stubResults[body.method] };
		}
		return { ok: true, status: 200, json: async () => ({ error: { message: 'unknown' } }) };
	};

	beforeAll(async () => {
		appChain = await buildApp({
			db,
			sparkPath,
			morphoPath,
			shadowPath,
			rateLimit: false,
			logger: false,
			installX402: false,
			incomeCfg: { enabled: false, reason: 'disabled-in-tests' },
			chainRpcUrls: { monero: 'http://stub-monero', zcash: 'http://stub-zcash' },
			chainRpcConfigured: { monero: true, zcash: true },
			fetchImpl: stubFetch,
			x402Cfg: {
				enabled: true,
				recipient: '0x1234567890abcdef1234567890abcdef12345678',
				network: 'eip155:8453',
				facilitatorUrl: 'https://x402.org/facilitator',
				routes: {
					'GET /v1/q/xmr/height': {
						accepts: { scheme: 'exact', payTo: '0x1234567890abcdef1234567890abcdef12345678', price: '$0.001', network: 'eip155:8453', maxTimeoutSeconds: 120 },
						description: 'q: xmr/height', mimeType: 'application/json'
					}
				}
			}
		});
	});
	afterAll(async () => { await appChain?.close?.(); });

	test('GET /v1/q lists chain questions with availability', async () => {
		const r = await appChain.inject({ method: 'GET', url: '/v1/q' });
		expect(r.statusCode).toBe(200);
		const body = r.json();
		const xmrHeight = body.questions.find(q => q.name === 'xmr/height');
		expect(xmrHeight).toBeDefined();
		expect(xmrHeight.available).toBe(true);
		expect(xmrHeight.category).toBe('monero');
		expect(body.chain_status).toEqual({ monero: true, zcash: true });
	});

	test('GET /v1/q/xmr/height returns flat shape', async () => {
		const r = await appChain.inject({ method: 'GET', url: '/v1/q/xmr/height' });
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.chain).toBe('monero');
		expect(body.height).toBe(100);
		expect(body.synchronized).toBe(true);
	});

	test('GET /v1/q/zec/last-block fans out to two RPCs', async () => {
		const r = await appChain.inject({ method: 'GET', url: '/v1/q/zec/last-block' });
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.chain).toBe('zcash');
		expect(body.hash).toBe('beef');
		expect(body.height).toBe(200);
	});

	test('second call hits cache (no fresh upstream)', async () => {
		const r1 = await appChain.inject({ method: 'GET', url: '/v1/q/xmr/mempool' });
		const r2 = await appChain.inject({ method: 'GET', url: '/v1/q/xmr/mempool' });
		const b1 = r1.json();
		const b2 = r2.json();
		expect(b1._cache).toBe('miss');
		expect(b2._cache).toBe('hit');
		expect(b1.count).toBe(b2.count);
	});

	test('unconfigured chain → 503', async () => {
		const appUnset = await buildApp({
			db,
			sparkPath,
			morphoPath,
			shadowPath,
			rateLimit: false,
			logger: false,
			installX402: false,
			incomeCfg: { enabled: false, reason: 'disabled-in-tests' },
			chainRpcConfigured: { monero: false, zcash: false },
			x402Cfg: {
				enabled: true,
				recipient: '0x1234567890abcdef1234567890abcdef12345678',
				network: 'eip155:8453',
				facilitatorUrl: 'https://x402.org/facilitator',
				routes: {}
			}
		});
		const r = await appUnset.inject({ method: 'GET', url: '/v1/q/xmr/height' });
		expect(r.statusCode).toBe(503);
		expect(r.json().error.code).toBe('chain_not_configured');
		await appUnset.close();
	});

	test('failing upstream → 502 with chain_rpc_failed', async () => {
		const appBad = await buildApp({
			db,
			sparkPath,
			morphoPath,
			shadowPath,
			rateLimit: false,
			logger: false,
			installX402: false,
			incomeCfg: { enabled: false, reason: 'disabled-in-tests' },
			chainRpcUrls: { monero: 'http://stub', zcash: 'http://stub' },
			chainRpcConfigured: { monero: true, zcash: true },
			fetchImpl: async () => { throw new Error('connection refused'); },
			x402Cfg: {
				enabled: true,
				recipient: '0x1234567890abcdef1234567890abcdef12345678',
				network: 'eip155:8453',
				facilitatorUrl: 'https://x402.org/facilitator',
				routes: {}
			}
		});
		const r = await appBad.inject({ method: 'GET', url: '/v1/q/xmr/height' });
		expect(r.statusCode).toBe(502);
		expect(r.json().error.code).toBe('chain_rpc_failed');
		await appBad.close();
	});
});

describe('private watch routes', () => {
	let appWatch;
	const webhookHits = [];
	const watchPort = 'https://example.com/hook';
	// NFPT stub: lightwallet-status -> ok; monero start -> 202 + ids;
	// monero poll -> running scan; everything else -> 200 empty.
	let scriptedMonero = [
		{ status: 200, body: { success: true, data: { lightwallet: { connected: true, blockHeight: 3_400_000 } } } }
	];
	let moneroIdx = 0;
	function nfptStubFetch(url, init) {
		const path = String(url).replace(/^https?:\/\/[^/]+/u, '');
		if (path === '/api/wallet-scanner/lightwallet/status') {
			return Promise.resolve({
				status: 200,
				text: async () => JSON.stringify({ success: true, data: { lightwallet: { connected: true, blockHeight: 3_400_000 } } })
			});
		}
		const next = scriptedMonero[Math.min(moneroIdx, scriptedMonero.length - 1)];
		moneroIdx += 1;
		return Promise.resolve({
			status: next.status,
			text: async () => JSON.stringify(next.body)
		});
	}

	function watchFetch(url, init) {
		// Composite stub: NFPT-targeted URLs go through the scripted
		// stub; webhook-target URLs (example.com) capture the post.
		if (String(url).startsWith('http://nfpt')) return nfptStubFetch(url, init);
		webhookHits.push({ url, init });
		return Promise.resolve({ status: 200, text: async () => 'ok' });
	}

	beforeAll(async () => {
		const masterKey = Buffer.from('11'.repeat(32), 'hex');
		const { openWatchDb } = await import('../src/private-watch-store.js');
		const watchDb = openWatchDb(':memory:');
		const { createNfptClient } = await import('../src/private-watch-nfpt.js');
		const nfptClient = createNfptClient({
			baseUrl: 'http://nfpt',
			apiKey: 'k',
			fetchImpl: watchFetch
		});
		appWatch = await buildApp({
			db, sparkPath, morphoPath, shadowPath,
			rateLimit: false,
			logger: false,
			installX402: false,
			incomeCfg: { enabled: false, reason: 'disabled-in-tests' },
			watchDb,
			watchMasterKey: masterKey,
			nfptClient,
			// Test webhook URLs use example.com; stub DNS so the
			// suite doesn't depend on a working resolver.
			webhookResolver: {
				resolve4: async (host) => host === 'example.com' ? ['93.184.216.34'] : (() => { const e = new Error('na'); e.code = 'ENODATA'; throw e; })(),
				resolve6: async () => { const e = new Error('na'); e.code = 'ENODATA'; throw e; }
			},
			// Route the /test endpoint's outbound POST through the
			// composite stub so the test can assert on it.
			webhookFetchImpl: watchFetch,
			// Disable HTTPS-only so the loopback-SSRF test exercises
			// the IP guard rather than tripping the scheme check.
			privateWatchRequireHttps: false,
			x402Cfg: {
				enabled: true,
				recipient: '0x1234567890abcdef1234567890abcdef12345678',
				network: 'eip155:8453',
				facilitatorUrl: 'https://x402.org/facilitator',
				routes: {
					'POST /v1/private/watch': {
						accepts: { scheme: 'exact', payTo: '0x1234567890abcdef1234567890abcdef12345678', price: '$0.10', network: 'eip155:8453', maxTimeoutSeconds: 120 },
						description: 'private watch',
						mimeType: 'application/json'
					},
					'POST /v1/private/topup': {
						accepts: { scheme: 'exact', payTo: '0x1234567890abcdef1234567890abcdef12345678', price: '$0.10', network: 'eip155:8453', maxTimeoutSeconds: 120 },
						description: 'topup 10c',
						mimeType: 'application/json'
					},
					'POST /v1/private/topup-1': {
						accepts: { scheme: 'exact', payTo: '0x1234567890abcdef1234567890abcdef12345678', price: '$1.00', network: 'eip155:8453', maxTimeoutSeconds: 120 },
						description: 'topup 1usd',
						mimeType: 'application/json'
					},
					'POST /v1/private/topup-5': {
						accepts: { scheme: 'exact', payTo: '0x1234567890abcdef1234567890abcdef12345678', price: '$5.00', network: 'eip155:8453', maxTimeoutSeconds: 120 },
						description: 'topup 5usd',
						mimeType: 'application/json'
					},
					'POST /v1/private/historical': {
						accepts: { scheme: 'exact', payTo: '0x1234567890abcdef1234567890abcdef12345678', price: '$0.50', network: 'eip155:8453', maxTimeoutSeconds: 120 },
						description: 'historical',
						mimeType: 'application/json'
					}
				}
			}
		});
	});

	afterAll(async () => { await appWatch?.close?.(); });

	test('GET /v1/private/info returns price + chains + upstream health', async () => {
		moneroIdx = 0;
		const r = await appWatch.inject({ method: 'GET', url: '/v1/private/info' });
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.chains).toEqual(['monero', 'zcash']);
		expect(body.pricing.watch_creation).toBe('$0.10');
		expect(body.upstream.ok).toBe(true);
	});

	test('GET /v1/private/health returns stats only', async () => {
		const r = await appWatch.inject({ method: 'GET', url: '/v1/private/health' });
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.enabled).toBe(true);
		expect(body.stats.by_chain).toBeDefined();
	});

	test('POST /v1/private/watch creates a Monero watch', async () => {
		moneroIdx = 0;
		const r = await appWatch.inject({
			method: 'POST',
			url: '/v1/private/watch',
			payload: {
				chain: 'monero',
				address: '4' + 'A'.repeat(94),
				viewKey: '5'.repeat(64),
				webhookUrl: watchPort
			}
		});
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.watchId).toMatch(/^[0-9a-f-]{36}$/u);
		expect(body.watchToken.length).toBeGreaterThan(20);
		expect(body.webhookSecret).toMatch(/^[0-9a-f]{64}$/u);
		expect(body.chain).toBe('monero');
		expect(body.signatureHeader).toMatch(/HMAC-SHA256/);
	});

	test('POST /v1/private/watch rejects invalid chain (400)', async () => {
		moneroIdx = 0;
		const r = await appWatch.inject({
			method: 'POST',
			url: '/v1/private/watch',
			payload: { chain: 'btc', address: 'x', viewKey: 'y', webhookUrl: 'https://example.com' }
		});
		expect(r.statusCode).toBe(400);
		expect(r.json().error.code).toBe('invalid_request');
	});

	test('POST /v1/private/watch rejects loopback webhook (400 SSRF guard)', async () => {
		moneroIdx = 0;
		const r = await appWatch.inject({
			method: 'POST',
			url: '/v1/private/watch',
			payload: {
				chain: 'monero',
				address: '4' + 'A'.repeat(94),
				viewKey: '5'.repeat(64),
				webhookUrl: 'http://127.0.0.1:6379/'
			}
		});
		expect(r.statusCode).toBe(400);
	});

	test('POST /v1/private/watch rejects IPv6 loopback (400 SSRF guard)', async () => {
		moneroIdx = 0;
		const r = await appWatch.inject({
			method: 'POST',
			url: '/v1/private/watch',
			payload: {
				chain: 'monero',
				address: '4' + 'A'.repeat(94),
				viewKey: '5'.repeat(64),
				webhookUrl: 'http://[::1]:8080/'
			}
		});
		expect(r.statusCode).toBe(400);
		expect(r.json().error.message).toMatch(/(IPv6|not allowed)/);
	});

	test('POST /v1/private/watch accepts (and ignores) positive durationDays for back-compat', async () => {
		// Old clients may still pass `durationDays`; we silently
		// ignore it because the meter is credit-driven. Negative /
		// zero values are still rejected.
		moneroIdx = 0;
		const r = await appWatch.inject({
			method: 'POST',
			url: '/v1/private/watch',
			payload: {
				chain: 'monero',
				address: '4' + 'A'.repeat(94),
				viewKey: '5'.repeat(64),
				webhookUrl: watchPort,
				durationDays: 30
			}
		});
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.creditAtomic).toBe('100000');
		// Surge pricing: the rate depends on the live active-watch
		// count in this shared test DB. Assert that it's a digit
		// string at or above the documented base ($0.02) and at
		// or below the cap ($0.25), and that the response carries
		// the surge metadata the panel/docs rely on.
		const ratePerDay = Number(body.ratePerDayAtomic);
		expect(ratePerDay).toBeGreaterThanOrEqual(20_000);
		expect(ratePerDay).toBeLessThanOrEqual(250_000);
		expect(['base', 'surge', 'cap']).toContain(body.pricingTier);
		expect(typeof body.activeWatchesAtCreation).toBe('number');
	});

	test('POST /v1/private/watch rejects negative durationDays (400)', async () => {
		moneroIdx = 0;
		const r = await appWatch.inject({
			method: 'POST',
			url: '/v1/private/watch',
			payload: {
				chain: 'monero',
				address: '4' + 'A'.repeat(94),
				viewKey: '5'.repeat(64),
				webhookUrl: watchPort,
				durationDays: -1
			}
		});
		expect(r.statusCode).toBe(400);
		expect(r.json().error.message).toMatch(/deprecated/);
	});

	test('POST /v1/private/watch rejects DNS-rebind to 127.0.0.1 (400)', async () => {
		// Build a one-off app whose DNS resolver maps the test host
		// onto loopback to simulate a DNS-based SSRF.
		const { openWatchDb } = await import('../src/private-watch-store.js');
		const watchDb2 = openWatchDb(':memory:');
		const { createNfptClient } = await import('../src/private-watch-nfpt.js');
		const okClient = createNfptClient({
			baseUrl: 'http://nfpt', apiKey: 'k', fetchImpl: nfptStubFetch
		});
		moneroIdx = 0;
		const appRebind = await buildApp({
			db, sparkPath, morphoPath, shadowPath,
			rateLimit: false, logger: false, installX402: false,
			incomeCfg: { enabled: false, reason: 'disabled-in-tests' },
			watchDb: watchDb2,
			watchMasterKey: Buffer.from('44'.repeat(32), 'hex'),
			nfptClient: okClient,
			privateWatchRequireHttps: false,
			webhookResolver: {
				resolve4: async () => ['127.0.0.1'],
				resolve6: async () => { const e = new Error('na'); e.code = 'ENODATA'; throw e; }
			},
			x402Cfg: {
				enabled: true,
				recipient: '0x1234567890abcdef1234567890abcdef12345678',
				network: 'eip155:8453',
				facilitatorUrl: 'https://x402.org/facilitator',
				routes: {
					'POST /v1/private/watch': {
						accepts: { scheme: 'exact', payTo: '0x1234567890abcdef1234567890abcdef12345678', price: '$0.10', network: 'eip155:8453', maxTimeoutSeconds: 120 },
						description: 'private watch',
						mimeType: 'application/json'
					}
				}
			}
		});
		const r = await appRebind.inject({
			method: 'POST',
			url: '/v1/private/watch',
			payload: {
				chain: 'monero',
				address: '4' + 'A'.repeat(94),
				viewKey: '5'.repeat(64),
				webhookUrl: 'http://attacker.example/hook'
			}
		});
		expect(r.statusCode).toBe(400);
		expect(r.json().error.message).toMatch(/private IPv4 127\.0\.0\.1/);
		await appRebind.close();
	});

	test('POST /v1/private/watch/:id/test fires a synthetic signed webhook', async () => {
		moneroIdx = 0;
		const c = await appWatch.inject({
			method: 'POST',
			url: '/v1/private/watch',
			payload: {
				chain: 'monero',
				address: '4' + 'F'.repeat(94),
				viewKey: 'a'.repeat(64),
				webhookUrl: watchPort
			}
		});
		const { watchId, watchToken, webhookSecret } = c.json();
		expect(c.json().testEndpoint).toBe(`/v1/private/watch/${watchId}/test`);
		const before = webhookHits.length;
		const r = await appWatch.inject({
			method: 'POST',
			url: `/v1/private/watch/${watchId}/test`,
			headers: { 'x-watch-token': watchToken }
		});
		expect(r.statusCode).toBe(200);
		expect(r.json().delivered).toBe(true);
		expect(r.json().event).toBe('synthetic_test');
		expect(webhookHits.length).toBe(before + 1);
		const hit = webhookHits[webhookHits.length - 1];
		const headers = hit.init?.headers ?? {};
		expect(headers['x-seneschal-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
		expect(headers['x-seneschal-event']).toBe('synthetic_test');
		// Receiver computes its own HMAC and compares against ours.
		// The wire-format secret is 32 random bytes encoded as 64 hex
		// chars; signing keys those bytes, not the hex string.
		const { createHmac } = await import('node:crypto');
		const expected = 'sha256=' + createHmac('sha256', Buffer.from(webhookSecret, 'hex'))
			.update(hit.init.body, 'utf8').digest('hex');
		expect(headers['x-seneschal-signature']).toBe(expected);
	});

	test('POST /v1/private/watch/:id/test rejects bad token (403)', async () => {
		moneroIdx = 0;
		const c = await appWatch.inject({
			method: 'POST',
			url: '/v1/private/watch',
			payload: {
				chain: 'monero',
				address: '4' + 'G'.repeat(94),
				viewKey: 'b'.repeat(64),
				webhookUrl: watchPort
			}
		});
		const { watchId } = c.json();
		const r = await appWatch.inject({
			method: 'POST',
			url: `/v1/private/watch/${watchId}/test`,
			headers: { 'x-watch-token': 'nope' }
		});
		expect(r.statusCode).toBe(403);
	});

	test('GET /v1/stats/overview includes private_watch block', async () => {
		moneroIdx = 0;
		const r = await appWatch.inject({ method: 'GET', url: '/v1/stats/overview' });
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.private_watch).toBeDefined();
		expect(body.private_watch.enabled).toBe(true);
		expect(body.private_watch.price_create).toBe('$0.10');
		expect(body.private_watch.rate_per_day_atomic).toBe('20000');
		expect(body.private_watch.rate_per_call_atomic).toBe('5000');
		expect(body.private_watch.stats.by_chain).toBeDefined();
		expect(body.private_watch.stats.credit).toBeDefined();
	});

	test('POST /v1/private/topup adds $0.10 credit and updates expires_at', async () => {
		moneroIdx = 0;
		const c = await appWatch.inject({
			method: 'POST', url: '/v1/private/watch',
			payload: { chain: 'monero', address: '4' + 'T'.repeat(94), viewKey: 'c'.repeat(64), webhookUrl: watchPort }
		});
		const { watchId, watchToken } = c.json();
		const before = await appWatch.inject({
			method: 'GET', url: `/v1/private/watch/${watchId}`,
			headers: { 'x-watch-token': watchToken }
		});
		const beforeBody = before.json();
		const r = await appWatch.inject({
			method: 'POST', url: '/v1/private/topup',
			payload: { watchId, watchToken }
		});
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.tier).toBe('/v1/private/topup');
		expect(body.creditAppliedAtomic).toBe('100000');
		expect(body.credit.remaining_atomic).toBe(String(Number(beforeBody.credit.remaining_atomic) + 100_000));
	});

	test('POST /v1/private/topup-5 adds $5 credit', async () => {
		moneroIdx = 0;
		const c = await appWatch.inject({
			method: 'POST', url: '/v1/private/watch',
			payload: { chain: 'monero', address: '4' + 'U'.repeat(94), viewKey: 'd'.repeat(64), webhookUrl: watchPort }
		});
		const { watchId, watchToken } = c.json();
		const r = await appWatch.inject({
			method: 'POST', url: '/v1/private/topup-5',
			payload: { watchId, watchToken }
		});
		expect(r.statusCode).toBe(200);
		expect(r.json().creditAppliedAtomic).toBe('5000000');
	});

	test('POST /v1/private/topup with wrong token returns 403', async () => {
		moneroIdx = 0;
		const c = await appWatch.inject({
			method: 'POST', url: '/v1/private/watch',
			payload: { chain: 'monero', address: '4' + 'V'.repeat(94), viewKey: 'e'.repeat(64), webhookUrl: watchPort }
		});
		const { watchId } = c.json();
		const r = await appWatch.inject({
			method: 'POST', url: '/v1/private/topup',
			payload: { watchId, watchToken: 'wrong' }
		});
		expect(r.statusCode).toBe(403);
	});

	test('POST /v1/private/topup with non-UUID watchId returns 400', async () => {
		const r = await appWatch.inject({
			method: 'POST', url: '/v1/private/topup',
			payload: { watchId: 'nope', watchToken: 'x' }
		});
		expect(r.statusCode).toBe(400);
		expect(r.json().error.message).toMatch(/UUID/);
	});

	test('POST /v1/private/historical returns totals from NFPT', async () => {
		moneroIdx = 0;
		const saved = scriptedMonero;
		// Script: start-monero job, poll-completed (loop body),
		// raw-job re-fetch, cancel.
		scriptedMonero = [
			{ status: 202, body: { success: true, data: { jobId: 'HJ1', jobToken: 'HT1' } } },
			{ status: 200, body: { success: true, data: { job: {
				status: 'completed',
				progress: { scannedHeight: 100, chainHeight: 100, scanProgress: 1, percentComplete: 100, blocksScanned: 50_000 },
				balance: { totalAtomic: '1234' },
				transactions: [
					{ amount: '1000', height: 50, txHash: 'aa', direction: 'in' },
					{ amount: '234',  height: 90, txHash: 'bb', direction: 'in' }
				],
				error: null
			} } } },
			{ status: 200, body: { success: true, data: { job: {
				status: 'completed',
				progress: { scannedHeight: 100, chainHeight: 100, scanProgress: 1, percentComplete: 100, blocksScanned: 50_000 },
				balance: { totalAtomic: '1234' },
				transactions: [
					{ amount: '1000', height: 50, txHash: 'aa', direction: 'in' },
					{ amount: '234',  height: 90, txHash: 'bb', direction: 'in' }
				],
				error: null
			} } } },
			{ status: 200, body: { success: true } }
		];
		const r = await appWatch.inject({
			method: 'POST', url: '/v1/private/historical',
			payload: {
				chain: 'monero',
				address: '4' + 'H'.repeat(94),
				viewKey: 'f'.repeat(64),
				includeNotes: true
			}
		});
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.chain).toBe('monero');
		expect(body.totals.received_atomic).toBe('1234');
		expect(body.notes).toHaveLength(2);
		expect(body.view_key_handling).toMatch(/in memory/);
		scriptedMonero = saved;
		moneroIdx = 0;
	});

	test('POST /v1/private/historical rejects malformed body (400)', async () => {
		const r = await appWatch.inject({
			method: 'POST', url: '/v1/private/historical',
			payload: { chain: 'monero', address: 'too-short', viewKey: 'x' }
		});
		expect(r.statusCode).toBe(400);
	});

	test('POST /v1/private/derive-viewkey forwards to NFPT and returns UFVK', async () => {
		moneroIdx = 0;
		const saved = scriptedMonero;
		scriptedMonero = [
			{ status: 200, body: { success: true, data: { ufvk: 'uview1abc', sapling_fvk: null, transparent_fvk: null } } }
		];
		const phrase = Array(24).fill('abandon').join(' ');
		const r = await appWatch.inject({
			method: 'POST', url: '/v1/private/derive-viewkey',
			payload: { chain: 'zcash', phrase }
		});
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.ufvk).toBe('uview1abc');
		expect(body.word_count).toBe(24);
		expect(body.WARNING).toMatch(/seed phrase/);
		scriptedMonero = saved;
		moneroIdx = 0;
	});

	test('POST /v1/private/derive-viewkey rejects monero (not supported)', async () => {
		const r = await appWatch.inject({
			method: 'POST', url: '/v1/private/derive-viewkey',
			payload: { chain: 'monero', phrase: Array(24).fill('abandon').join(' ') }
		});
		expect(r.statusCode).toBe(400);
		expect(r.json().error.message).toMatch(/Zcash/);
	});

	test('POST /v1/private/derive-viewkey rejects oversized phrase (400)', async () => {
		const r = await appWatch.inject({
			method: 'POST', url: '/v1/private/derive-viewkey',
			payload: { chain: 'zcash', phrase: 'a'.repeat(500) }
		});
		expect(r.statusCode).toBe(400);
	});

	test('GET /v1/private/watch/:id needs the watch token', async () => {
		moneroIdx = 0;
		// create
		const c = await appWatch.inject({
			method: 'POST',
			url: '/v1/private/watch',
			payload: {
				chain: 'monero',
				address: '4' + 'B'.repeat(94),
				viewKey: '6'.repeat(64),
				webhookUrl: watchPort
			}
		});
		const { watchId, watchToken } = c.json();
		// no token -> 403
		const denied = await appWatch.inject({ method: 'GET', url: `/v1/private/watch/${watchId}` });
		expect(denied.statusCode).toBe(403);
		// correct token -> 200 + summary
		const ok = await appWatch.inject({
			method: 'GET',
			url: `/v1/private/watch/${watchId}`,
			headers: { 'x-watch-token': watchToken }
		});
		expect(ok.statusCode).toBe(200);
		const body = ok.json();
		expect(body.watchId).toBe(watchId);
		expect(body.chain).toBe('monero');
		expect(JSON.stringify(body)).not.toContain('view_key');
		expect(JSON.stringify(body)).not.toContain(watchToken);
	});

	test('DELETE cancels the watch', async () => {
		moneroIdx = 0;
		const c = await appWatch.inject({
			method: 'POST',
			url: '/v1/private/watch',
			payload: {
				chain: 'monero',
				address: '4' + 'C'.repeat(94),
				viewKey: '7'.repeat(64),
				webhookUrl: watchPort
			}
		});
		const { watchId, watchToken } = c.json();
		const del = await appWatch.inject({
			method: 'DELETE',
			url: `/v1/private/watch/${watchId}`,
			headers: { 'x-watch-token': watchToken }
		});
		expect(del.statusCode).toBe(200);
		expect(del.json().cancelled).toBe(true);
		const status = await appWatch.inject({
			method: 'GET',
			url: `/v1/private/watch/${watchId}`,
			headers: { 'x-watch-token': watchToken }
		});
		expect(status.json().cancelled).toBe(true);
	});

	test('NFPT unhealthy -> POST returns 502 without charging payment', async () => {
		const { openWatchDb } = await import('../src/private-watch-store.js');
		const watchDb = openWatchDb(':memory:');
		const { createNfptClient } = await import('../src/private-watch-nfpt.js');
		const downClient = createNfptClient({
			baseUrl: 'http://nfpt',
			apiKey: 'k',
			fetchImpl: async () => ({ status: 500, text: async () => '{}' })
		});
		const appDown = await buildApp({
			db, sparkPath, morphoPath, shadowPath,
			rateLimit: false, logger: false, installX402: false,
			incomeCfg: { enabled: false, reason: 'disabled-in-tests' },
			watchDb,
			watchMasterKey: Buffer.from('22'.repeat(32), 'hex'),
			nfptClient: downClient,
			webhookResolver: {
				resolve4: async () => ['93.184.216.34'],
				resolve6: async () => { const e = new Error('na'); e.code = 'ENODATA'; throw e; }
			},
			privateWatchRequireHttps: false,
			x402Cfg: {
				enabled: true,
				recipient: '0x1234567890abcdef1234567890abcdef12345678',
				network: 'eip155:8453',
				facilitatorUrl: 'https://x402.org/facilitator',
				routes: {
					'POST /v1/private/watch': {
						accepts: { scheme: 'exact', payTo: '0x1234567890abcdef1234567890abcdef12345678', price: '$0.10', network: 'eip155:8453', maxTimeoutSeconds: 120 },
						description: 'private watch',
						mimeType: 'application/json'
					}
				}
			}
		});
		const r = await appDown.inject({
			method: 'POST',
			url: '/v1/private/watch',
			payload: {
				chain: 'monero',
				address: '4' + 'D'.repeat(94),
				viewKey: '8'.repeat(64),
				webhookUrl: watchPort
			}
		});
		expect(r.statusCode).toBe(502);
		expect(r.json().error.code).toBe('nfpt_upstream_unavailable');
		await appDown.close();
	});

	test('POST returns 503 when paywall is unconfigured', async () => {
		const { openWatchDb } = await import('../src/private-watch-store.js');
		const watchDb = openWatchDb(':memory:');
		const { createNfptClient } = await import('../src/private-watch-nfpt.js');
		const upClient = createNfptClient({
			baseUrl: 'http://nfpt', apiKey: 'k', fetchImpl: nfptStubFetch
		});
		const appNoPaywall = await buildApp({
			db, sparkPath, morphoPath, shadowPath,
			rateLimit: false, logger: false, installX402: false,
			incomeCfg: { enabled: false, reason: 'disabled-in-tests' },
			watchDb,
			watchMasterKey: Buffer.from('33'.repeat(32), 'hex'),
			nfptClient: upClient,
			x402Cfg: { enabled: false, reason: 'no recipient' }
		});
		const r = await appNoPaywall.inject({
			method: 'POST',
			url: '/v1/private/watch',
			payload: {
				chain: 'monero',
				address: '4' + 'E'.repeat(94),
				viewKey: '9'.repeat(64),
				webhookUrl: watchPort
			}
		});
		expect(r.statusCode).toBe(503);
		expect(r.json().error.code).toBe('paywall_not_configured');
		await appNoPaywall.close();
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
