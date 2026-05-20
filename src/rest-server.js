// Public Seneschal REST API.
//
// Surface (all GET unless noted):
//   /v1/health
//   /v1/liquidations/atrisk?protocol&max_hf&min_debt_usd&limit
//   /v1/liquidations/recent?since_ms&limit&protocol
//   /v1/borrowers/:address?
//   /v1/borrowers/:address/history?protocol&since_ms&until_ms&granularity&limit
//   /v1/builders/leaderboard?window&limit
//
// Errors are surfaced as { error: { code, message } } with the appropriate
// HTTP status. Validation errors from queries.js bubble up as 400.

import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';

import config from './config.js';
import {
	openLiveDb,
	fileMtimeMs
} from './db.js';
import {
	getHealth,
	listAtRiskBorrowers,
	listBorrowers,
	recentLiquidations,
	getBorrower,
	getBorrowerHistory,
	getBuilderLeaderboard,
	getStatsOverview
} from './queries.js';
import { filterProviders, FLASHLOAN_PROVIDERS } from './flashloan-providers.js';
import { getPremiumOpportunities, getPremiumBuilderStats } from './queries-premium.js';
import { buildX402Config, registerX402, describePaywall } from './x402.js';
import { buildIncomeConfig, createIncomeCache } from './income.js';
import { readIncomeHistory, bucketSeriesDaily } from './income-history.js';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const MAX_HISTORY_WINDOW_MS = 90 * ONE_DAY_MS;
const DEFAULT_HISTORY_WINDOW_MS = 30 * ONE_DAY_MS;

// Bound the time window the history endpoint will consider. Caps at
// 90 days because beyond that the daily-bucket payload starts to
// dominate the response and the chart becomes unreadable anyway.
function clampWindow(raw) {
	if (raw === undefined || raw === null) return DEFAULT_HISTORY_WINDOW_MS;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) {
		throw new TypeError(`window_ms: ${raw} must be a positive number`);
	}
	return Math.min(Math.max(n, ONE_HOUR_MS), MAX_HISTORY_WINDOW_MS);
}

// `buildApp` is exported separately so tests can spin up a Fastify
// instance against a fixture DB without touching the live one.
export async function buildApp(options = {}) {
	const app = Fastify({
		logger: options.logger ?? { level: process.env.LOG_LEVEL ?? 'info' },
		trustProxy: options.trustProxy ?? true
	});

	const db = options.db ?? openLiveDb();
	const shadowPath = options.shadowPath ?? config.shadowBlocksPath;
	const morphoPath = options.morphoPath ?? config.morphoBorrowersPath;
	const sparkPath = options.sparkPath ?? config.sparkBorrowersPath;
	const ttlMs = options.leaderboardTtlMs ?? config.leaderboardCacheTtlMs;
	const apiVersion = options.apiVersion ?? config.apiVersion;

	await app.register(cors, {
		origin: true,
		methods: ['GET', 'OPTIONS'],
		maxAge: 86400
	});

	if (options.rateLimit !== false) {
		await app.register(rateLimit, {
			max: options.rateLimitMax ?? config.rateLimitPerMin,
			timeWindow: options.rateLimitWindow ?? config.rateLimitTimeWindowMs,
			cache: 10000,
			allowList: options.rateLimitAllowList ?? []
		});
	}

	// Global error handler: validation errors become 400, anything else 500.
	app.setErrorHandler((err, req, reply) => {
		if (err instanceof TypeError || err.statusCode === 400) {
			req.log.warn({ err: err.message, url: req.url }, 'bad request');
			return reply.code(400).send({
				error: { code: 'invalid_request', message: err.message }
			});
		}
		req.log.error({ err: err.stack ?? err.message, url: req.url }, 'unhandled');
		return reply.code(500).send({
			error: { code: 'internal_error', message: 'internal error' }
		});
	});

	const x402Cfg = options.x402Cfg ?? buildX402Config();
	const paywallSummary = describePaywall(x402Cfg);

	// Income-telemetry config is derived from `config.js` defaults
	// (paymaster + entry-point + rpc) merged with the live x402
	// recipient. Tests inject their own via `options.incomeCfg`.
	const incomeCfg = options.incomeCfg ?? buildIncomeConfig({
		cfg: {
			paymasterAddress: config.paymasterAddress,
			entryPointAddress: config.entryPointAddress,
			baseRpcUrl: config.baseRpcUrl,
			ethUsd: config.ethUsd,
			cacheTtlMs: config.incomeCacheTtlMs,
			x402RecipientAddress: config.x402RecipientAddress
		},
		env: process.env
	});
	const incomeCache = createIncomeCache({ ttlMs: config.incomeCacheTtlMs });

	app.get('/', async () => ({
		service: config.serviceName,
		version: apiVersion,
		docs: 'https://docs.seneschal.space',
		stats_dashboard: 'https://stats.seneschal.space',
		endpoints: [
			'GET /v1/health',
			'GET /v1/liquidations/atrisk',
			'GET /v1/liquidations/recent',
			'GET /v1/borrowers',
			'GET /v1/borrowers/:address',
			'GET /v1/borrowers/:address/history',
			'GET /v1/builders/leaderboard',
			'GET /v1/stats/overview',
			'GET /v1/stats/income',
			'GET /v1/stats/income/history',
			'GET /v1/flashloan/providers',
			'GET /v1/premium/opportunities (x402 paywall)',
			'GET /v1/premium/builder-stats (x402 paywall)'
		],
		paywall: paywallSummary
	}));

	app.get('/v1/health', async () => {
		return getHealth(db, {
			version: apiVersion,
			morphoMtimeMs: fileMtimeMs(morphoPath),
			sparkMtimeMs: fileMtimeMs(sparkPath),
			shadowMtimeMs: fileMtimeMs(shadowPath)
		});
	});

	app.get('/v1/liquidations/atrisk', async (req) => {
		const q = req.query ?? {};
		return listAtRiskBorrowers(db, {
			protocol: q.protocol,
			max_hf: q.max_hf,
			min_debt_usd: q.min_debt_usd,
			limit: q.limit,
			_sparkPath: sparkPath
		});
	});

	app.get('/v1/liquidations/recent', async (req) => {
		const q = req.query ?? {};
		return recentLiquidations(db, {
			since_ms: q.since_ms,
			limit: q.limit,
			protocol: q.protocol
		});
	});

	// Generic borrower listing — discovery endpoint with HF range,
	// debt range, sort, and offset pagination. Distinct from
	// /v1/liquidations/atrisk which is the convenience-shaped subset.
	app.get('/v1/borrowers', async (req) => {
		const q = req.query ?? {};
		return listBorrowers(db, {
			protocol: q.protocol,
			min_hf: q.min_hf,
			max_hf: q.max_hf,
			min_debt_usd: q.min_debt_usd,
			max_debt_usd: q.max_debt_usd,
			sort_by: q.sort_by,
			sort_dir: q.sort_dir,
			limit: q.limit,
			offset: q.offset
		});
	});

	app.get('/v1/borrowers/:address', async (req) => {
		return getBorrower(db, {
			address: req.params.address,
			_sparkPath: sparkPath
		});
	});

	app.get('/v1/borrowers/:address/history', async (req) => {
		const q = req.query ?? {};
		return getBorrowerHistory(db, {
			address: req.params.address,
			protocol: q.protocol,
			since_ms: q.since_ms,
			until_ms: q.until_ms,
			granularity: q.granularity,
			limit: q.limit
		});
	});

	app.get('/v1/builders/leaderboard', async (req) => {
		const q = req.query ?? {};
		return getBuilderLeaderboard({
			window: q.window,
			limit: q.limit,
			_shadowPath: shadowPath,
			_ttlMs: ttlMs
		});
	});

	// Single bundled endpoint feeding stats.seneschal.space. Returns
	// all the aggregates the dashboard needs in one round trip so the
	// page renders fast even on slow connections. Cached implicitly
	// via the leaderboard sub-call (60s TTL); the other aggregates
	// take ~50ms. The income snapshot has its own cache so the RPC
	// reads don't gate the page render.
	app.get('/v1/stats/overview', async (req) => {
		const overview = await getStatsOverview(db, {
			_shadowPath: shadowPath,
			_sparkPath: sparkPath,
			_ttlMs: ttlMs
		});
		try {
			overview.income = await incomeCache.get(incomeCfg);
		} catch (err) {
			overview.income = { enabled: false, reason: `income read failed: ${err?.message ?? String(err)}` };
			req.log.warn({ err: err?.message ?? String(err) }, 'income snapshot read failed');
		}
		return overview;
	});

	// Standalone income endpoint — same data as overview.income but
	// available without the rest of the overview payload (~30 KB). Cheap
	// to poll separately (cached upstream by `incomeCache`).
	app.get('/v1/stats/income', async (req, reply) => {
		if (!incomeCfg.enabled) {
			reply.code(503);
			return { enabled: false, reason: incomeCfg.reason ?? 'income disabled' };
		}
		try {
			return await incomeCache.get(incomeCfg);
		} catch (err) {
			reply.code(502);
			req.log.warn({ err: err?.message ?? String(err) }, 'income snapshot read failed');
			return {
				enabled: false,
				reason: `income read failed: ${err?.message ?? String(err)}`
			};
		}
	});

	// Historical income time series for the treasury chart on
	// stats.seneschal.space. Reads the JSONL file written by
	// scripts/income-poller.mjs. Two views: `series` (raw hourly rows)
	// and `daily` (one row per UTC day, latest-in-day reading).
	const snapshotsPath = options.incomeSnapshotsPath ?? config.incomeSnapshotsPath;
	app.get('/v1/stats/income/history', async (req) => {
		const q = req.query ?? {};
		const windowMs = clampWindow(q.window_ms);
		const sinceMs = Date.now() - windowMs;
		const hist = await readIncomeHistory(snapshotsPath, { sinceMs });
		return {
			...hist,
			window_ms: windowMs,
			daily: bucketSeriesDaily(hist.series ?? [])
		};
	});

	// Curated mainnet flash-loan provider catalogue. Pure static data,
	// no DB hit. Helps MEV agents discover providers when planning a
	// liquidation strategy. Query params filter the catalogue:
	//   ?max_fee_bps=10   ?multi_asset=true   ?chain=ethereum
	app.get('/v1/flashloan/providers', async (req) => {
		const q = req.query ?? {};
		const filtered = filterProviders({
			chain: q.chain ?? 'ethereum',
			maxFeeBps: q.max_fee_bps != null ? Number(q.max_fee_bps) : null,
			multiAsset: q.multi_asset === 'true' ? true : null
		});
		return {
			providers: filtered,
			total: filtered.length,
			catalogue_size: FLASHLOAN_PROVIDERS.length,
			filters: {
				chain: q.chain ?? 'ethereum',
				max_fee_bps: q.max_fee_bps != null ? Number(q.max_fee_bps) : null,
				multi_asset: q.multi_asset === 'true' ? true : null
			},
			note: 'Static catalogue. Caller must verify live liquidity per provider before relying on a specific amount.'
		};
	});

	// Premium endpoints sit behind the x402 paywall when configured,
	// otherwise they surface 503 so the surface area remains
	// discoverable even on a fresh install.
	app.get('/v1/premium/opportunities', async (req, reply) => {
		if (!x402Cfg.enabled) {
			return reply.code(503).send({
				error: {
					code: 'paywall_not_configured',
					message: 'Premium feed requires the operator to set X402_RECIPIENT_ADDRESS (see /paywall info).'
				}
			});
		}
		const q = req.query ?? {};
		return getPremiumOpportunities(db, {
			since_ms: q.since_ms,
			min_debt_usd: q.min_debt_usd,
			limit: q.limit,
			liquidation_bonus: q.liquidation_bonus
		});
	});

	// Per-builder bid distribution + hourly histogram. The free
	// /v1/builders/leaderboard answers "who's winning?"; this one
	// answers "what value do I need to land in their bundle?", which
	// is the question searchers actually pay for.
	app.get('/v1/premium/builder-stats', async (req, reply) => {
		if (!x402Cfg.enabled) {
			return reply.code(503).send({
				error: {
					code: 'paywall_not_configured',
					message: 'Premium feed requires the operator to set X402_RECIPIENT_ADDRESS (see /paywall info).'
				}
			});
		}
		const q = req.query ?? {};
		return getPremiumBuilderStats({
			window_ms: q.window_ms,
			limit: q.limit,
			_shadowPath: shadowPath
		});
	});

	// Always-on metadata endpoint describing the paywall — agents can
	// introspect price + rails without making a paid call first.
	app.get('/v1/paywall', async () => {
		return paywallSummary ?? { enabled: false, reason: 'X402_RECIPIENT_ADDRESS not set' };
	});

	// `/.well-known/x402` — opt-in discovery manifest matching the
	// emerging convention that x402 service-discovery agents (e.g.
	// Agorion, coinbase/x402 #1379) scrape from a provider's apex
	// domain. Same content as /v1/paywall but at the path discovery
	// crawlers actually look at. Empty when the paywall is off so
	// crawlers don't index a no-op endpoint.
	app.get('/.well-known/x402', async (req, reply) => {
		if (!paywallSummary) {
			reply.code(404);
			return { error: { code: 'paywall_not_configured', message: 'No x402 paywall configured on this host.' } };
		}
		return {
			...paywallSummary,
			service: {
				name: 'Seneschal Data API',
				homepage: 'https://seneschal.space',
				docs: 'https://docs.seneschal.space/#premium-tier-x402',
				api_root: 'https://api.seneschal.space',
				mcp: 'https://mcp.seneschal.space'
			}
		};
	});

	app.setNotFoundHandler((req, reply) => {
		reply.code(404).send({
			error: { code: 'not_found', message: `route ${req.method} ${req.url} not found` }
		});
	});

	if (x402Cfg.enabled && options.installX402 !== false) {
		// Side-effecty bit isolated at the end so the rest of the
		// route registration is order-independent. If the @x402
		// install fails (e.g. missing peer deps) we log loudly but
		// keep the public service up.
		try {
			await registerX402(app, x402Cfg);
		}
		catch (err) {
			app.log.error({ err: err?.stack ?? err?.message ?? String(err) }, 'x402 paywall registration failed; premium endpoints will answer 503');
		}
	}

	return app;
}

// Entrypoint helper for bin/rest.mjs.
export async function start() {
	const app = await buildApp();
	await app.listen({ port: config.restPort, host: config.restHost });
	return app;
}
