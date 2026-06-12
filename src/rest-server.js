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
import { buildOpenApiDocument } from './openapi.js';
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
// The paid privacy-payments surface (Private Watch /v1/private/*, the
// privacy-chain /v1/q/xmr|zec/* facts, and the XMR/ZEC + custom top-up
// routes) is the embedded `payments-gateway` package — one plugin call
// below replaces what used to be ~500 lines of route handlers here.
import registerGatewayRoutes from 'payments-gateway/rest-plugin';
import { CHAIN_QUESTION_REGISTRY } from 'payments-gateway';
import {
	SENESCHAL_SERVICE_NAME,
	SENESCHAL_SIGNATURE_HEADER,
	SENESCHAL_WEBHOOK_USER_AGENT,
	SENESCHAL_MEMO_PREFIX,
	SENESCHAL_DERIVE_DOCS_URL
} from './private-watch.js';
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
		// these numbers. The block (prices, custom-topup bounds, surge
		// pricing, per-chain stats) comes from the embedded gateway.
		// Wrapped in try/catch because a corrupt DB shouldn't take the
		// whole stats page down.
		try {
			overview.private_watch = gateway.buildPrivateWatchStats();
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

	// ── Embedded payments gateway ──────────────────────────────────
	// One plugin call mounts the entire paid privacy surface that used
	// to live inline here (~500 lines): the /v1/q/xmr/* + /v1/q/zec/*
	// chain facts and the full Private Watch family (/v1/private/*
	// create/status/cancel/test, fixed + custom + XMR/ZEC top-ups,
	// historical scans, derive-viewkey). Seneschal branding — service
	// name, X-Seneschal-Signature webhook headers, the SNS- memo
	// prefix and the offline-derivation docs link — rides in via the
	// injected config, so route behaviour and response wording stay
	// identical to the pre-split handlers. The returned handle feeds
	// the cross-cutting routes below (/v1/q catalogue, stats overview).
	const gateway = registerGatewayRoutes(app, {
		config: {
			...config,
			serviceName: SENESCHAL_SERVICE_NAME,
			webhookSignatureHeader: SENESCHAL_SIGNATURE_HEADER,
			memoPrefix: SENESCHAL_MEMO_PREFIX
		},
		x402Cfg,
		requirePaywall,
		webhookUserAgent: SENESCHAL_WEBHOOK_USER_AGENT,
		deriveDocsUrl: SENESCHAL_DERIVE_DOCS_URL,
		memoPrefix: SENESCHAL_MEMO_PREFIX,
		// Test injection points — option names unchanged from the
		// pre-split buildApp signature so the suite needs no edits.
		watchDb: options.watchDb,
		watchDbPath: options.watchDbPath,
		watchMasterKey: options.watchMasterKey,
		nfptClient: options.nfptClient,
		disablePrivateWatch: options.disablePrivateWatch,
		webhookResolver: options.webhookResolver,
		privateWatchRequireHttps: options.privateWatchRequireHttps,
		webhookFetchImpl: options.webhookFetchImpl,
		fetchImpl: options.fetchImpl,
		chainRpcUrls: options.chainRpcUrls,
		chainRpcConfigured: options.chainRpcConfigured,
		chainCache: options.chainCache,
		chainCacheTtlMs: options.chainCacheTtlMs,
		chainRpcTimeoutMs: options.chainRpcTimeoutMs,
		cryptoRecvAddresses: options.cryptoRecvAddresses,
		cryptoPriceOracle: options.cryptoPriceOracle
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
			available: gateway.chainRpcConfigured[meta.chain] === true
		}));
		return {
			price_per_call: price,
			network: x402Cfg.enabled ? x402Cfg.network : null,
			questions: [...defi, ...chain],
			chain_status: gateway.chainRpcConfigured
		};
	});

	// Always-on metadata endpoint describing the paywall — agents can
	// introspect price + rails without making a paid call first.
	app.get('/v1/paywall', async () => {
		return paywallSummary ?? { enabled: false, reason: 'X402_RECIPIENT_ADDRESS not set' };
	});

	// `/openapi.json` — canonical machine-readable contract. x402
	// indexers (x402scan and friends) require this document and verify
	// its x-payment-info prices against live 402 challenges, so it is
	// derived from the SAME x402Cfg the paywall runs on. Built once at
	// startup: the catalogue and prices are fixed for the process
	// lifetime.
	const openApiDoc = buildOpenApiDocument({ x402Cfg });
	app.get('/openapi.json', async () => openApiDoc);

	// `/favicon.ico` — x402scan (and browsers hitting the API root)
	// look for an icon at the origin; the listing shows a blank tile
	// without one. Loaded lazily + cached so a missing file in dev
	// degrades to a plain 404 rather than a startup failure.
	let faviconCache;
	app.get('/favicon.ico', async (req, reply) => {
		if (faviconCache === undefined) {
			try {
				faviconCache = await readFile(new URL('../docs/favicon.ico', import.meta.url));
			}
			catch {
				faviconCache = null;
			}
		}
		if (!faviconCache) {
			reply.code(404);
			return { error: { code: 'not_found', message: 'no favicon' } };
		}
		reply.header('content-type', 'image/x-icon');
		reply.header('cache-control', 'public, max-age=86400');
		return reply.send(faviconCache);
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
				description: 'Monero & Zcash payment webhooks (HMAC-signed, view-key only, no node) plus on-chain DeFi liquidation and Ethereum builder telemetry — all payable per call over x402 on Base. Free read tier, no API key, no account.',
				homepage: 'https://seneschal.space',
				docs: 'https://docs.seneschal.space',
				api_root: 'https://api.seneschal.space',
				mcp: 'https://mcp.seneschal.space',
				control_panel: 'https://panel.seneschal.space',
				stats: 'https://stats.seneschal.space',
				contact: 'https://t.me/OrknetP',
				products: [
					{
						name: 'Private Watch',
						summary: 'Watch a Monero or Zcash view key for inbound payments and receive an HMAC-signed webhook on each one. Credit-metered (per-day + per-call), no node to run.',
						start: 'POST /v1/private/watch',
						info: 'https://api.seneschal.space/v1/private/info',
						panel: 'https://panel.seneschal.space'
					},
					{
						name: 'DeFi + builder data',
						summary: 'Real-time at-risk borrowers across Aave/Morpho/Spark/Compound, Ethereum builder market share, and Monero/Zcash chain facts. Free read tier; x402 premium feeds + Penny Oracle atomic facts.',
						start: 'GET /v1/premium/opportunities',
						info: 'https://api.seneschal.space/v1/paywall'
					}
				]
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
