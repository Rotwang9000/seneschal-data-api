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
import {
	qLiquidatable,
	qAtRiskCount,
	qRecentLiquidations,
	qBuilderFacts,
	qCheapestFlashloan,
	qDataFreshness,
	QUESTION_REGISTRY
} from './queries-q.js';
import {
	dispatchChainQuestion,
	createChainCache,
	CHAIN_QUESTION_REGISTRY
} from './queries-q-chain.js';
import {
	openWatchDb,
	createWatch as storeCreateWatch,
	getWatch as storeGetWatch,
	cancelWatch as storeCancelWatch,
	topupWatch as storeTopupWatch,
	statsSnapshot as storeStatsSnapshot
} from './private-watch-store.js';
import {
	parseMasterKey,
	encryptViewKey,
	generateWebhookSecret
} from './private-watch-crypto.js';
import {
	createNfptClient,
	healthCheck as nfptHealthCheck,
	scanHistorical,
	deriveUfvk
} from './private-watch-nfpt.js';
import {
	resolveAndValidateWatchRequest,
	validateTopupRequest,
	validateHistoricalRequest,
	validateDeriveRequest,
	buildWatchSummary,
	buildPrivateInfo,
	buildCreditBlock,
	buildSyntheticTestBody,
	effectiveRatesForRow,
	WATCH_CONSTANTS
} from './private-watch.js';
import { deliverWebhook } from './private-watch-poller.js';
import {
	registerCustomTopupRoute,
	CUSTOM_TOPUP_LIMITS
} from './private-watch-custom.js';
import {
	buildPricingConfig,
	computeWatchRate,
	describeCurrentPricing
} from './private-watch-pricing.js';
import { readFile } from 'node:fs/promises';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
// Public ops-health endpoint reads the watchdog's last-written
// state file. Path is overridable via env so dev/test can point
// it at a fixture without touching prod paths.
const OPS_STATE_FILE_DEFAULT = '/var/lib/seneschal-ops-monitor/state.json';
const OPS_STATE_MAX_AGE_MS = 30 * 60 * 1000; // > 2x watchdog cadence
const MAX_HISTORY_WINDOW_MS = 90 * ONE_DAY_MS;
const DEFAULT_HISTORY_WINDOW_MS = 30 * ONE_DAY_MS;

// Try to ping the NFPT scanner; never throw — return the structured
// failure so callers (rest endpoints) can surface it without taking
// the route down. Used by /v1/private/info + the POST handler.
async function safeHealth(nfptClient) {
	try { return await nfptHealthCheck(nfptClient); }
	catch (err) { return { ok: false, reason: err?.message ?? String(err) }; }
}

function safeHost(url) {
	try { return new URL(url).hostname; }
	catch { return null; }
}

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
		// `origin: true` reflects the request origin (no credentials are
		// used, so this is equivalent to allow-any). POST is allowed so
		// the in-page derive-viewkey form on docs.seneschal.space (and
		// any future hosted demo widget) can call the API from the
		// browser. The endpoints themselves are protected by x402 +
		// per-route rate limits — CORS isn't the security control.
		origin: true,
		methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
		allowedHeaders: ['content-type', 'x-payment', 'x-watch-token'],
		// `payment-required` carries the base64-encoded x402 challenge
		// on 402 responses; the in-browser panel at panel.seneschal.space
		// (and any future browser-based x402 client) MUST be able to
		// read it via fetch().headers.get(...). DELETE is allowed for
		// the watch-cancel route. The x-ratelimit-* headers help the
		// derive form back off gracefully.
		exposedHeaders: ['payment-required', 'x-payment-response', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'],
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

	// Global error handler. Specific status codes (429 rate-limit, 413
	// payload-too-large, etc.) MUST be preserved — otherwise clients
	// get a useless 500 with no Retry-After hint. Validation errors
	// land as 400 with a stable shape; everything unrecognised becomes
	// 500 to avoid leaking implementation details.
	app.setErrorHandler((err, req, reply) => {
		if (err instanceof TypeError || err.statusCode === 400) {
			req.log.warn({ err: err.message, url: req.url }, 'bad request');
			return reply.code(400).send({
				error: { code: 'invalid_request', message: err.message }
			});
		}
		if (err.statusCode === 429) {
			req.log.warn({ err: err.message, url: req.url }, 'rate limited');
			return reply
				.code(429)
				.header('retry-after', '60')
				.send({
					error: { code: 'rate_limited', message: err.message ?? 'rate limit exceeded' }
				});
		}
		if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
			// Pass through other 4xx (validation, auth, payload size).
			req.log.warn({ err: err.message, url: req.url, statusCode: err.statusCode }, 'client error');
			return reply.code(err.statusCode).send({
				error: { code: err.code ?? 'client_error', message: err.message ?? 'client error' }
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
			ethUsdFeed: config.ethUsdFeed,
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
			'GET /v1/premium/builder-stats (x402 paywall)',
			'GET /v1/q (penny-oracle catalogue, free)',
			'GET /v1/q/* (penny-oracle atomic-fact endpoints, x402 paywall)',
			'GET /v1/q/xmr/* (Monero atomic-fact endpoints, x402 paywall)',
			'GET /v1/q/zec/* (Zcash atomic-fact endpoints, x402 paywall)',
			'POST /v1/private/watch (x402 paywall — view-key payment monitor, starter credit)',
			'POST /v1/private/topup (x402 paywall — $0.10 credit top-up)',
			'POST /v1/private/topup-1 (x402 paywall — $1.00 credit top-up)',
			'POST /v1/private/topup-5 (x402 paywall — $5.00 credit top-up)',
			'POST /v1/private/topup-custom (x402 paywall — variable credit amount, 0.10 – 25.00 USDC)',
			'POST /v1/private/historical (x402 paywall — one-off spendable+spent note scan)',
			'POST /v1/private/derive-viewkey (free, rate-limited — Zcash UFVK from BIP-39 mnemonic)',
			'GET /v1/private/watch/:id (owner-only, free poll)',
			'DELETE /v1/private/watch/:id (owner-only, free cancel)',
			'POST /v1/private/watch/:id/test (owner-only, fires a synthetic webhook)',
			'GET /v1/private/info (free service metadata)',
			'GET /v1/private/health (free counters, no PII)'
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

	// Public ops health endpoint — exposes what the watchdog
	// timer wrote on its last tick. We never read systemd from
	// inside the REST process (the watchdog is the privileged
	// one). When the state file is missing OR older than ~2x the
	// watchdog cadence we report `overall: "stale"` so a silent
	// watchdog failure is itself visible. The stats page polls
	// this for the ops dot.
	const opsStateFile = options.opsStateFile ?? config.opsStateFile ?? OPS_STATE_FILE_DEFAULT;
	app.get('/v1/ops/health', async (_req, reply) => {
		try {
			const buf = await readFile(opsStateFile, 'utf8');
			const report = JSON.parse(buf);
			const ageMs = Date.now() - Number(report?.generatedAtMs ?? 0);
			if (!Number.isFinite(ageMs) || ageMs > OPS_STATE_MAX_AGE_MS) {
				reply.code(503);
				return {
					overall: 'stale',
					reason: `watchdog state is ${Math.round(ageMs / 60_000)} min old (max ${Math.round(OPS_STATE_MAX_AGE_MS / 60_000)} min)`,
					generatedAtMs: report?.generatedAtMs ?? 0,
					ageMs,
					units: report?.units ?? {},
					scripts: report?.scripts ?? {}
				};
			}
			if (report.overall !== 'ok') reply.code(503);
			return { ...report, ageMs };
		}
		catch (err) {
			reply.code(503);
			return {
				overall: 'unknown',
				reason: err?.code === 'ENOENT'
					? `no watchdog state at ${opsStateFile}`
					: `read failed: ${err?.message ?? String(err)}`,
				generatedAtMs: 0
			};
		}
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
		// Private Watch live counters. We fold them into the overview
		// so the dashboard doesn't need a second request and so the
		// "no PII" health surface stays the only public source of
		// these numbers. Wrapped in try/catch because a corrupt DB
		// shouldn't take the whole stats page down.
		try {
			if (watchDb) {
				const routes = x402Cfg?.routes ?? {};
				overview.private_watch = {
					enabled: privateWatchReady(),
					price_create: routes['POST /v1/private/watch']?.accepts?.price ?? null,
					price_topup_10c: routes['POST /v1/private/topup']?.accepts?.price ?? null,
					price_topup_1: routes['POST /v1/private/topup-1']?.accepts?.price ?? null,
					price_topup_5: routes['POST /v1/private/topup-5']?.accepts?.price ?? null,
					price_historical: routes['POST /v1/private/historical']?.accepts?.price ?? null,
					// Variable-amount top-ups live alongside the three
					// fixed tiers. Surface the bounds so the in-browser
					// slider can clamp client-side without a separate
					// fetch.
					topup_custom: {
						min_atomic: String(CUSTOM_TOPUP_LIMITS.MIN_ATOMIC),
						max_atomic: String(CUSTOM_TOPUP_LIMITS.MAX_ATOMIC),
						step_atomic: String(CUSTOM_TOPUP_LIMITS.MIN_ATOMIC)
					},
					// Existing constant-rate fields kept for back-compat;
					// the live surge numbers are below in `surge_pricing`.
					rate_per_day_atomic: String(WATCH_CONSTANTS.DAY_RATE_ATOMIC),
					rate_per_call_atomic: String(WATCH_CONSTANTS.CALL_RATE_ATOMIC),
					low_credit_threshold_atomic: String(WATCH_CONSTANTS.LOW_CREDIT_THRESHOLD_ATOMIC),
					surge_pricing: describeCurrentPricing({
						pricing: pricingCfg,
						activeWatches: storeStatsSnapshot(watchDb)?.active ?? 0
					}),
					poll_interval_sec: config.privateWatchPollIntervalSec,
					stats: storeStatsSnapshot(watchDb)
				};
			}
			else {
				overview.private_watch = { enabled: false, reason: 'watch DB not opened' };
			}
		}
		catch (err) {
			overview.private_watch = { enabled: false, reason: `private-watch read failed: ${err?.message ?? String(err)}` };
			req.log.warn({ err: err?.message ?? String(err) }, 'private-watch snapshot failed');
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

	// ── Penny Oracle: /v1/q/* atomic-fact endpoints ────────────
	// Each is paywalled by @x402/fastify (priced via X402_Q_PRICE),
	// then this handler runs a single SQL or static lookup. Designed
	// to be safe to hit in a tight agent loop — every call is <50 ms
	// and returns a flat object the agent can branch on.
	const requirePaywall = (reply) => {
		if (x402Cfg.enabled) return null;
		reply.code(503).send({
			error: {
				code: 'paywall_not_configured',
				message: 'The Penny Oracle requires the operator to set X402_RECIPIENT_ADDRESS (see /paywall info).'
			}
		});
		return reply;
	};

	app.get('/v1/q/liquidatable', async (req, reply) => {
		if (requirePaywall(reply)) return;
		return qLiquidatable(db, req.query ?? {});
	});
	app.get('/v1/q/at-risk-count', async (req, reply) => {
		if (requirePaywall(reply)) return;
		return qAtRiskCount(db, req.query ?? {});
	});
	app.get('/v1/q/recent-liquidations', async (req, reply) => {
		if (requirePaywall(reply)) return;
		return qRecentLiquidations(db, req.query ?? {});
	});
	app.get('/v1/q/top-builder', async (req, reply) => {
		if (requirePaywall(reply)) return;
		return qBuilderFacts({ window: (req.query ?? {}).window, projection: 'top-builder' }, { shadowPath });
	});
	app.get('/v1/q/builder-share', async (req, reply) => {
		if (requirePaywall(reply)) return;
		const q = req.query ?? {};
		return qBuilderFacts({ window: q.window, builder: q.builder, projection: 'share' }, { shadowPath });
	});
	app.get('/v1/q/builder-bid', async (req, reply) => {
		if (requirePaywall(reply)) return;
		const q = req.query ?? {};
		return qBuilderFacts({ window: q.window, builder: q.builder, pct: q.pct, projection: 'bid' }, { shadowPath });
	});
	app.get('/v1/q/cheapest-flashloan', async (req, reply) => {
		if (requirePaywall(reply)) return;
		return qCheapestFlashloan(req.query ?? {});
	});
	app.get('/v1/q/data-freshness', async (req, reply) => {
		if (requirePaywall(reply)) return;
		return qDataFreshness(db, req.query ?? {}, { paths: { shadowPath } });
	});

	// ── Privacy-chain atomic facts: /v1/q/xmr/* and /v1/q/zec/* ──
	// These reach out to an upstream monerod / zebra JSON-RPC. The
	// RPC URLs live in env (MONERO_RPC_URL, ZCASH_RPC_URL); when a
	// chain is unconfigured we 503 with `chain_not_configured` so
	// agent SDKs surface a clean signal instead of a generic 502.
	// Responses are cached in-process for `CHAIN_CACHE_TTL_MS` so a
	// hot loop hammering /v1/q/xmr/height costs the daemon nothing.
	const chainRpcUrls = options.chainRpcUrls ?? {
		monero: config.moneroRpcUrl,
		zcash: config.zcashRpcUrl
	};
	const chainRpcConfigured = options.chainRpcConfigured ?? {
		monero: Boolean(chainRpcUrls.monero),
		zcash: Boolean(chainRpcUrls.zcash)
	};
	const chainCache = options.chainCache ?? createChainCache({
		ttlMs: options.chainCacheTtlMs ?? config.chainCacheTtlMs
	});
	const chainDeps = {
		fetchImpl: options.fetchImpl ?? globalThis.fetch,
		timeoutMs: options.chainRpcTimeoutMs ?? config.chainRpcTimeoutMs
	};

	function chainNotConfigured(reply, chain) {
		reply.code(503).send({
			error: {
				code: 'chain_not_configured',
				message: `${chain.toUpperCase()} RPC is not configured on this server. Set ${chain === 'monero' ? 'MONERO_RPC_URL' : 'ZCASH_RPC_URL'} to enable.`
			}
		});
	}

	for (const [name, meta] of Object.entries(CHAIN_QUESTION_REGISTRY)) {
		app.get(`/v1/q/${name}`, async (req, reply) => {
			if (requirePaywall(reply)) return;
			if (!chainRpcConfigured[meta.chain]) {
				chainNotConfigured(reply, meta.chain);
				return;
			}
			try {
				return await chainCache.get(`q:${name}`, () =>
					dispatchChainQuestion({ name, deps: chainDeps, rpcUrls: chainRpcUrls })
				);
			} catch (err) {
				req.log.error({ err: err?.message ?? String(err), name }, 'chain question failed');
				reply.code(502);
				return {
					error: {
						code: 'chain_rpc_failed',
						message: err?.message ?? 'upstream RPC error',
						chain: meta.chain
					}
				};
			}
		});
	}

	// ── Private watch (view-key based payment monitoring) ─────────
	// One x402-paid POST creates a server-side scanner subscription
	// for a Monero or Zcash address. The scanner work happens in NFPT
	// (local box at 3555); we own state, paywall, webhook signing.
	const privateWatchEnabled = Boolean(config.privateWatchEncryptionKey);
	// Pricing config is cheap to build (just env reads + validation)
	// so we do it unconditionally. The watch-creation handler reads
	// it to compute the surge factor for each new row.
	const pricingCfg = buildPricingConfig(config);
	let watchDb = options.watchDb ?? null;
	let watchMasterKey = options.watchMasterKey ?? null;
	let nfptClient = options.nfptClient ?? null;
	// `webhookResolver` is the dns.promises-compatible resolver used
	// by resolveAndValidateWatchRequest. Tests inject a stub so the
	// suite doesn't depend on real DNS for `example.com`. Production
	// gets the default node:dns/promises resolver.
	const webhookResolver = options.webhookResolver ?? undefined;
	// HTTPS-only switch is config-driven by default but tests can
	// flip it off without setting an env var.
	const privateWatchRequireHttps = options.privateWatchRequireHttps
		?? (config.privateWatchRequireHttps && !config.privateWatchAllowPrivateWebhooks);
	// Fetch override used when delivering webhooks (the /test endpoint).
	// Tests inject a stub; production uses globalThis.fetch.
	const webhookFetchImpl = options.webhookFetchImpl ?? globalThis.fetch;
	if (privateWatchEnabled && options.disablePrivateWatch !== true) {
		try {
			watchMasterKey = watchMasterKey ?? parseMasterKey(config.privateWatchEncryptionKey);
		}
		catch (err) {
			app.log.error({ err: err?.message ?? String(err) }, 'private-watch: PRIVATE_WATCH_ENCRYPTION_KEY invalid — POST /v1/private/watch will 503');
			watchMasterKey = null;
		}
		try {
			watchDb = watchDb ?? openWatchDb(options.watchDbPath ?? config.privateWatchDbPath);
		}
		catch (err) {
			app.log.error({ err: err?.message ?? String(err), path: config.privateWatchDbPath }, 'private-watch: failed to open watch DB');
			watchDb = null;
		}
		nfptClient = nfptClient ?? createNfptClient({
			baseUrl: config.nfptBaseUrl,
			apiKey: config.nfptApiKey,
			timeoutMs: config.nfptTimeoutMs,
			fetchImpl: options.fetchImpl ?? globalThis.fetch
		});
	}

	const privateWatchReady = () => Boolean(watchDb && watchMasterKey && nfptClient);

	function privateNotConfigured(reply, extra = {}) {
		reply.code(503).send({
			error: {
				code: 'private_watch_not_configured',
				message: 'POST /v1/private/watch requires PRIVATE_WATCH_ENCRYPTION_KEY and a writable PRIVATE_WATCH_DB (see /v1/private/info).',
				...extra
			}
		});
	}

	app.get('/v1/private/info', async () => {
		const nfptHealth = privateWatchReady()
			? await safeHealth(nfptClient)
			: { ok: false, reason: 'private watch disabled' };
		const info = buildPrivateInfo({
			x402Cfg,
			nfptHealth,
			requireHttps: privateWatchRequireHttps
		});
		// Layer the live surge data on top of the static info
		// block so a caller can see what their *next* watch would
		// cost without first paying for one.
		if (watchDb) {
			const snap = storeStatsSnapshot(watchDb);
			info.surge_pricing = describeCurrentPricing({
				pricing: pricingCfg,
				activeWatches: snap?.active ?? 0
			});
		}
		return info;
	});

	app.get('/v1/private/health', async () => {
		if (!watchDb) return { enabled: false, reason: 'watch DB not opened' };
		return {
			enabled: privateWatchReady(),
			stats: storeStatsSnapshot(watchDb)
		};
	});

	app.post('/v1/private/watch', async (req, reply) => {
		if (requirePaywall(reply)) return;
		if (!privateWatchReady()) {
			return privateNotConfigured(reply);
		}
		let input;
		try {
			input = await resolveAndValidateWatchRequest(req.body ?? {}, {
				allowPrivateWebhooks: config.privateWatchAllowPrivateWebhooks,
				requireHttps: privateWatchRequireHttps,
				resolver: webhookResolver
			});
		}
		catch (err) {
			return reply.code(400).send({
				error: { code: 'invalid_request', message: err?.message ?? String(err) }
			});
		}
		// Upstream sanity check — if NFPT is dead we refuse the
		// payment-collection step entirely rather than charge the
		// user for a watch we can't service.
		const health = await safeHealth(nfptClient);
		if (!health?.ok) {
			return reply.code(502).send({
				error: {
					code: 'nfpt_upstream_unavailable',
					message: 'Upstream NFPT scanner is not reachable; refusing to create watch.',
					nfpt: health
				}
			});
		}
		const viewKeyCiphertext = encryptViewKey(input.viewKey, watchMasterKey);
		const webhookSecret = generateWebhookSecret();
		// Surge pricing: snap the rate for this new watch off the
		// current active-watch count and lock it in for the row's
		// lifetime. Existing watches keep their cheaper rate.
		const snapshot = storeStatsSnapshot(watchDb);
		const rate = computeWatchRate({ ...pricingCfg, activeWatches: snapshot?.active ?? 0 });
		const created = storeCreateWatch(watchDb, {
			chain: input.chain,
			address: input.address,
			viewKeyCiphertext,
			webhookUrl: input.webhookUrl,
			webhookSecret,
			birthdayHeight: input.birthdayHeight,
			creditAtomic: WATCH_CONSTANTS.STARTER_CREDIT_ATOMIC,
			dayRateAtomic: rate.dayRateAtomic,
			callRateAtomic: rate.callRateAtomic,
			lowCreditThresholdAtomic: rate.lowCreditThresholdAtomic,
			maxLifetimeMs: WATCH_CONSTANTS.MAX_WATCH_LIFETIME_MS,
			nowMs: input.now
		});
		req.log.info({
			watchId: created.id,
			chain: input.chain,
			webhookHost: safeHost(input.webhookUrl),
			creditAtomic: created.creditAtomic,
			dayRateAtomic: rate.dayRateAtomic,
			callRateAtomic: rate.callRateAtomic,
			activeWatchesAtCreation: rate.activeWatches,
			tier: rate.source
		}, 'private-watch: created');
		return {
			watchId: created.id,
			watchToken: created.token,
			webhookSecret,
			chain: input.chain,
			address: input.address,
			birthdayHeight: input.birthdayHeight,
			creditAtomic: String(created.creditAtomic),
			expiresAt: new Date(created.expiresAt).toISOString(),
			pollIntervalSec: WATCH_CONSTANTS.DEFAULT_POLL_INTERVAL_SEC,
			ratePerDayAtomic: String(rate.dayRateAtomic),
			ratePerCallAtomic: String(rate.callRateAtomic),
			lowCreditThresholdAtomic: String(rate.lowCreditThresholdAtomic),
			pricingTier: rate.source,
			activeWatchesAtCreation: rate.activeWatches,
			topupEndpoints: {
				'10c': '/v1/private/topup',
				'1usd': '/v1/private/topup-1',
				'5usd': '/v1/private/topup-5'
			},
			testEndpoint: `/v1/private/watch/${created.id}/test`,
			signatureHeader: 'X-Seneschal-Signature: sha256=<HMAC-SHA256(webhookSecret, body)>'
		};
	});

	// Tiered top-up routes. All three share the same handler shape
	// and the resolved `creditAtomic` is driven by the route path so
	// the x402 paywall (which matches "METHOD /path" exactly) can
	// gate each tier with its own price.
	const TOPUP_TIERS = Object.freeze({
		'/v1/private/topup':    WATCH_CONSTANTS.TOPUP_10C_ATOMIC,
		'/v1/private/topup-1':  WATCH_CONSTANTS.TOPUP_1_ATOMIC,
		'/v1/private/topup-5':  WATCH_CONSTANTS.TOPUP_5_ATOMIC
	});

	for (const [path, creditAtomic] of Object.entries(TOPUP_TIERS)) {
		app.post(path, async (req, reply) => {
			if (requirePaywall(reply)) return;
			if (!privateWatchReady()) return privateNotConfigured(reply);
			let body;
			try { body = validateTopupRequest(req.body ?? {}); }
			catch (err) {
				return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
			}
			// Read the watch's locked-in rate so top-up math + the
			// low-credit threshold both honour the surge price that
			// applied when the watch was created.
			const existing = storeGetWatch(watchDb, body.watchId, body.watchToken);
			const ratesForTopup = existing && !existing.error
				? effectiveRatesForRow(existing)
				: { dayRateAtomic: WATCH_CONSTANTS.DAY_RATE_ATOMIC, lowCreditThresholdAtomic: WATCH_CONSTANTS.LOW_CREDIT_THRESHOLD_ATOMIC };
			const out = storeTopupWatch(watchDb, body.watchId, body.watchToken, {
				creditAtomic,
				dayRateAtomic: ratesForTopup.dayRateAtomic,
				lowThresholdAtomic: ratesForTopup.lowCreditThresholdAtomic,
				maxLifetimeMs: WATCH_CONSTANTS.MAX_WATCH_LIFETIME_MS
			});
			if (!out.ok) {
				const code = out.reason === 'forbidden' ? 403 : out.reason === 'not_found' ? 404 : 409;
				return reply.code(code).send({ error: { code: out.reason, message: `top-up rejected: ${out.reason}` } });
			}
			req.log.info({
				watchId: body.watchId,
				tier: path,
				creditAtomic,
				newBalanceAtomic: out.row.credit_atomic
			}, 'private-watch: topup applied');
			return {
				watchId: out.row.id,
				tier: path,
				creditAppliedAtomic: String(creditAtomic),
				credit: buildCreditBlock(out.row),
				expiresAt: new Date(out.row.expires_at_ms).toISOString()
			};
		});
	}

	// Variable-amount top-up. Bypasses @x402/fastify (which can
	// only express fixed prices) and hand-rolls the challenge /
	// verify / settle dance against the same facilitator URL.
	// Implemented in private-watch-custom.js so this file stays
	// under the 1500-line refactor cliff.
	registerCustomTopupRoute(app, {
		watchDb,
		x402Cfg,
		requirePaywall,
		privateWatchReady,
		privateNotConfigured,
		log: app.log
	});

	// One-off historical scan. The view key is forwarded to NFPT in
	// memory and never written to disk; the route returns the
	// upstream's per-note breakdown so the receiver can reconcile
	// against their on-chain wallet. The x402 paywall fixes the
	// price (X402_PRIVATE_HISTORICAL_PRICE, default $0.50).
	app.post('/v1/private/historical', async (req, reply) => {
		if (requirePaywall(reply)) return;
		if (!nfptClient) {
			return reply.code(503).send({ error: { code: 'nfpt_not_configured', message: 'historical lookups require NFPT_BASE_URL' } });
		}
		let input;
		try { input = validateHistoricalRequest(req.body ?? {}); }
		catch (err) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
		}
		const health = await safeHealth(nfptClient);
		if (!health?.ok) {
			return reply.code(502).send({ error: { code: 'nfpt_upstream_unavailable', message: 'NFPT scanner unreachable', nfpt: health } });
		}
		const startedAt = Date.now();
		let result;
		try {
			result = await scanHistorical(nfptClient, {
				chain: input.chain,
				address: input.address,
				viewKey: input.viewKey,
				birthdayHeight: input.birthdayHeight,
				toHeight: input.toHeight,
				includeNotes: input.includeNotes,
				maxNotes: WATCH_CONSTANTS.HISTORICAL_MAX_NOTES
			});
		}
		catch (err) {
			req.log.warn({ err: err?.message ?? String(err) }, 'private-watch: historical scan failed');
			return reply.code(502).send({ error: { code: 'historical_scan_failed', message: err?.message ?? String(err) } });
		}
		req.log.info({
			chain: input.chain,
			notes_returned: result?.notes?.length ?? 0,
			elapsed_ms: Date.now() - startedAt
		}, 'private-watch: historical scan complete');
		return {
			chain: input.chain,
			address: input.address,
			birthdayHeight: input.birthdayHeight,
			toHeight: input.toHeight,
			scanned_at_ms: startedAt,
			elapsed_ms: Date.now() - startedAt,
			...result,
			view_key_handling: 'streamed to NFPT in memory only; not persisted to Seneschal DB or logs'
		};
	});

	// FREE, rate-limited derive-viewkey endpoint. Forwards a BIP-39
	// mnemonic to NFPT's orchard-scanner CLI and returns the UFVK
	// the user would have to share with us to set up a watch. This
	// is a CONVENIENCE, not a privacy guarantee — the phrase transits
	// our process. The response reminds the caller of that loudly.
	app.post('/v1/private/derive-viewkey', { config: { rateLimit: { max: config.privateWatchDerivePerIpPerMin ?? 6, timeWindow: '1 minute' } } }, async (req, reply) => {
		if (!nfptClient) {
			return reply.code(503).send({ error: { code: 'nfpt_not_configured', message: 'derive-viewkey requires NFPT_BASE_URL' } });
		}
		let input;
		try { input = validateDeriveRequest(req.body ?? {}); }
		catch (err) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
		}
		try {
			const result = await deriveUfvk(nfptClient, { mnemonic: input.phrase, network: input.network });
			req.log.info({ chain: input.chain, network: input.network, wordCount: input.wordCount }, 'private-watch: derive-viewkey ok');
			return {
				chain: input.chain,
				network: input.network,
				word_count: input.wordCount,
				ufvk: result.ufvk,
				sapling_fvk: result.sapling_fvk ?? null,
				transparent_fvk: result.transparent_fvk ?? null,
				WARNING: 'Your seed phrase transited our server over TLS. We do NOT log or persist it, but a network observer between you and us would have seen the bytes. For maximum safety, derive offline using the orchard-scanner binary on a trusted machine (see https://docs.seneschal.space/derive-locally). A UFVK is read-only and can ONLY observe incoming transactions; it cannot spend funds.'
			};
		}
		catch (err) {
			req.log.warn({ err: err?.message ?? String(err) }, 'private-watch: derive-viewkey failed');
			return reply.code(502).send({ error: { code: 'derive_failed', message: err?.message ?? String(err) } });
		}
	});

	app.get('/v1/private/watch/:id', async (req, reply) => {
		if (!privateWatchReady()) return privateNotConfigured(reply);
		const token = req.headers['x-watch-token'];
		const row = storeGetWatch(watchDb, req.params.id, token);
		if (!row) return reply.code(404).send({ error: { code: 'not_found', message: 'watch not found' } });
		if (row.error === 'forbidden') {
			return reply.code(403).send({ error: { code: 'forbidden', message: 'watch token mismatch' } });
		}
		return buildWatchSummary(row, { pollIntervalSec: config.privateWatchPollIntervalSec });
	});

	app.delete('/v1/private/watch/:id', async (req, reply) => {
		if (!privateWatchReady()) return privateNotConfigured(reply);
		const token = req.headers['x-watch-token'];
		const ok = storeCancelWatch(watchDb, req.params.id, token);
		if (!ok) return reply.code(404).send({ error: { code: 'not_found', message: 'watch not found or forbidden' } });
		return { cancelled: true };
	});

	// Free synthetic-test endpoint: owner pings this once to verify
	// their receiver's signature handling end-to-end before relying on
	// real payments. We sign with the same key as a real webhook but
	// stamp `event: "synthetic_test"` so well-behaved receivers can
	// branch and avoid processing it as a real payment.
	app.post('/v1/private/watch/:id/test', async (req, reply) => {
		if (!privateWatchReady()) return privateNotConfigured(reply);
		const token = req.headers['x-watch-token'];
		const row = storeGetWatch(watchDb, req.params.id, token);
		if (!row) return reply.code(404).send({ error: { code: 'not_found', message: 'watch not found' } });
		if (row.error === 'forbidden') {
			return reply.code(403).send({ error: { code: 'forbidden', message: 'watch token mismatch' } });
		}
		if (row.cancelled || row.dead) {
			return reply.code(409).send({ error: { code: 'watch_inactive', message: 'watch is cancelled or dead; create a new one' } });
		}
		const body = buildSyntheticTestBody({
			watchId: row.id,
			chain: row.chain,
			address: row.address,
			row,
			nowMs: Date.now()
		});
		const result = await deliverWebhook({
			url: row.webhook_url,
			body,
			secret: row.webhook_secret,
			watchId: row.id,
			fetchImpl: webhookFetchImpl,
			timeoutMs: config.privateWatchWebhookTimeoutMs,
			responseMaxBytes: config.privateWatchResponseMaxBytes
		});
		req.log.info({
			watchId: row.id,
			ok: result.ok,
			status: result.status,
			webhookHost: safeHost(row.webhook_url)
		}, 'private-watch: synthetic test delivered');
		const code = result.ok ? 200 : 502;
		return reply.code(code).send({
			delivered: result.ok,
			status: result.status,
			error: result.error,
			signature_header: 'X-Seneschal-Signature: sha256=<HMAC-SHA256(webhookSecret, body)>',
			event: 'synthetic_test'
		});
	});

	// Public catalogue: free GET that lists every Penny Oracle
	// question and its declared input parameters. Lets agents
	// discover the surface without making a paid call first.
	app.get('/v1/q', async () => {
		const price = x402Cfg.enabled
			? (x402Cfg.routes['GET /v1/q/liquidatable']?.accepts?.price ?? config.x402QPrice)
			: null;
		const defi = Object.entries(QUESTION_REGISTRY).map(([name, meta]) => ({
			name,
			path: `/v1/q/${name}`,
			inputs: meta.inputs,
			category: 'defi'
		}));
		const chain = Object.entries(CHAIN_QUESTION_REGISTRY).map(([name, meta]) => ({
			name,
			path: `/v1/q/${name}`,
			inputs: meta.inputs,
			category: meta.chain,
			available: chainRpcConfigured[meta.chain] === true
		}));
		return {
			price_per_call: price,
			network: x402Cfg.enabled ? x402Cfg.network : null,
			questions: [...defi, ...chain],
			chain_status: chainRpcConfigured
		};
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
