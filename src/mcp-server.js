// Public Seneschal MCP server (Streamable HTTP transport).
//
// Exposes the same six queries as the REST API as MCP tools so AI agents
// (Claude, Cursor, Continue, etc.) can call them natively. The tool
// implementations are thin wrappers that delegate to queries.js — same
// validation, same response shapes, same DB connection.
//
// Wire layout:
//   - one HTTP listener on $SENESCHAL_MCP_PORT (default 8811)
//   - Streamable HTTP transport in STATELESS mode (no session IDs).
//     Each request creates a fresh transport+server pair, so we can
//     trivially horizontally scale by adding processes.
//   - Tool input validated via Zod schemas; output is plain JSON.

import http from 'node:http';
import { randomUUID } from 'node:crypto';

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import config from './config.js';
import { openLiveDb, fileMtimeMs } from './db.js';
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
import { buildX402Config, describePaywall } from './x402.js';
import { dispatchQuestion, QUESTION_REGISTRY } from './queries-q.js';
import {
	dispatchChainQuestion,
	createChainCache,
	CHAIN_QUESTION_REGISTRY
} from './queries-q-chain.js';
import {
	openWatchDb,
	createWatch as storeCreateWatch
} from './private-watch-store.js';
import {
	parseMasterKey,
	encryptViewKey,
	generateWebhookSecret
} from './private-watch-crypto.js';
import {
	createNfptClient,
	healthCheck as nfptHealthCheck,
	deriveUfvk
} from './private-watch-nfpt.js';
import {
	resolveAndValidateWatchRequest,
	validateDeriveRequest,
	buildPrivateInfo,
	WATCH_CONSTANTS
} from './private-watch.js';

// ── Zod schemas ───────────────────────────────────────────────────────

// Shared bits.
const Protocol = z.enum(['aave', 'morpho', 'spark', 'compound']);
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/u, 'must be a 0x-prefixed 20-byte hex string');

// All number-shaped fields accept JSON numbers AND numeric strings so
// the API is forgiving when an agent passes "1.05" instead of 1.05.
const NumericString = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/u, 'must be a number')])
	.transform(v => typeof v === 'string' ? Number(v) : v);

const IntegerString = z.union([z.number().int(), z.string().regex(/^-?\d+$/u, 'must be an integer')])
	.transform(v => typeof v === 'string' ? Number.parseInt(v, 10) : v);

const Limit = IntegerString.refine(n => n >= 1 && n <= 500, { message: 'must be 1..500' });

// ── tool definitions ──────────────────────────────────────────────────

function asContent(obj) {
	return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

// Build a server instance. Exported so tests can build a fresh server
// with a fixture DB.
export function buildMcpServer(options = {}) {
	const db = options.db ?? openLiveDb();
	const shadowPath = options.shadowPath ?? config.shadowBlocksPath;
	const morphoPath = options.morphoPath ?? config.morphoBorrowersPath;
	const sparkPath = options.sparkPath ?? config.sparkBorrowersPath;
	const ttlMs = options.leaderboardTtlMs ?? config.leaderboardCacheTtlMs;
	const apiVersion = options.apiVersion ?? config.apiVersion;
	const x402Cfg = options.x402Cfg ?? buildX402Config();
	const paywallSummary = describePaywall(x402Cfg);

	// Privacy-chain RPC plumbing — mirrors rest-server.js. Tests
	// can override via options.chainRpcUrls / options.chainCache.
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

	const server = new McpServer({
		name: 'seneschal-data',
		version: apiVersion,
		title: 'Seneschal Data',
		description: 'Free, public liquidation + builder telemetry for DeFi (Aave, Morpho, Spark, Compound). No authentication; rate-limited at the Caddy layer. Premium feed (per-call x402 micropayment in USDC on Base) exposes the uncapped at-risk catalogue plus realised market intel.'
	});

	server.registerTool('seneschal_health', {
		title: 'Service health',
		description: 'Returns table sizes and data-source freshness timestamps for the Seneschal Data backend.',
		inputSchema: {}
	}, async () => {
		return asContent(getHealth(db, {
			version: apiVersion,
			morphoMtimeMs: fileMtimeMs(morphoPath),
			sparkMtimeMs: fileMtimeMs(sparkPath),
			shadowMtimeMs: fileMtimeMs(shadowPath)
		}));
	});

	server.registerTool('seneschal_list_at_risk_borrowers', {
		title: 'List at-risk borrowers',
		description: 'Current snapshot of borrowers across Aave, Morpho, and Spark whose health factor sits below `max_hf`, sorted ascending. Use `min_debt_usd` to ignore dust positions.',
		inputSchema: {
			protocol: Protocol.optional().describe('Restrict to one protocol; omit for all.'),
			max_hf: NumericString.optional().describe('Return only borrowers with health factor strictly less than this. Default: no cap.'),
			min_debt_usd: NumericString.optional().describe('Ignore positions with debt smaller than this many USD. Default: 0.'),
			limit: Limit.optional().describe('Max rows. Default 50, max 500.')
		}
	}, async (params) => {
		return asContent(listAtRiskBorrowers(db, { ...params, _sparkPath: sparkPath }));
	});

	server.registerTool('seneschal_list_borrowers', {
		title: 'List borrowers (generic)',
		description: 'Generic discovery surface over the borrower snapshot table. Like `seneschal_list_at_risk_borrowers` but with both lower and upper HF bounds, optional max-debt cap, configurable sort field/direction, and offset-based pagination. Use this to walk the catalogue without knowing borrower addresses in advance.',
		inputSchema: {
			protocol: Protocol.optional().describe('Restrict to one protocol; omit for all.'),
			min_hf: NumericString.optional().describe('Inclusive lower bound on health factor.'),
			max_hf: NumericString.optional().describe('Exclusive upper bound on health factor.'),
			min_debt_usd: NumericString.optional().describe('Minimum debt in USD (default 0).'),
			max_debt_usd: NumericString.optional().describe('Maximum debt in USD (default unbounded).'),
			sort_by: z.enum(['health_factor', 'debt_usd', 'collateral_usd', 'last_observed_ms']).optional().describe("Default 'health_factor'."),
			sort_dir: z.enum(['asc', 'desc']).optional().describe("Default 'asc'."),
			limit: Limit.optional().describe('Max rows per page. Default 50, max 500.'),
			offset: NumericString.optional().describe('Pagination offset. Default 0.')
		}
	}, async (params) => {
		return asContent(listBorrowers(db, params));
	});

	server.registerTool('seneschal_recent_liquidations', {
		title: 'Recent liquidations',
		description: 'Liquidations observed in the recent past, including both ones won by other liquidators (`outcome=won_by_other`) and ones we ourselves landed (`outcome=we_landed`). Sorted by timestamp descending.',
		inputSchema: {
			since_ms: IntegerString.optional().describe('Unix epoch milliseconds. Defaults to now − 24h.'),
			limit: Limit.optional().describe('Max rows. Default 50, max 500.'),
			protocol: Protocol.optional().describe('Restrict to one protocol.')
		}
	}, async (params) => {
		return asContent(recentLiquidations(db, params));
	});

	server.registerTool('seneschal_get_borrower', {
		title: 'Get borrower snapshot',
		description: 'Returns the latest known state of `address` across every protocol where we have data (Aave, Morpho, Spark). Pass the EOA / contract address as a 0x-prefixed 20-byte hex string.',
		inputSchema: {
			address: Address
		}
	}, async ({ address }) => {
		return asContent(getBorrower(db, { address, _sparkPath: sparkPath }));
	});

	server.registerTool('seneschal_get_borrower_history', {
		title: 'Get borrower history',
		description: 'Returns a time series of (timestamp, health_factor, collateral_usd, debt_usd) observations for `address` on `protocol`. Granularity defaults to raw observations; use `hour` or `day` for chart-friendly buckets.',
		inputSchema: {
			address: Address,
			protocol: z.enum(['aave', 'morpho']).describe('Only aave and morpho have history tables.'),
			since_ms: IntegerString.optional().describe('Unix epoch ms. Defaults to now − 7d.'),
			until_ms: IntegerString.optional().describe('Unix epoch ms. Defaults to now.'),
			granularity: z.enum(['raw', 'hour', 'day']).optional().describe('Bucket size; default raw.'),
			limit: Limit.optional().describe('Max rows fetched from history table before bucketing.')
		}
	}, async (params) => {
		return asContent(getBorrowerHistory(db, params));
	});

	server.registerTool('seneschal_builder_leaderboard', {
		title: 'Builder leaderboard',
		description: "Slot-by-slot ground-truth share of Ethereum mainnet block builders observed by Seneschal's shadow recorder, with total MEV captured per builder in the window. Cached for 60s.",
		inputSchema: {
			window: z.enum(['24h', '7d', '30d', 'all']).optional().describe('Lookback window. Default 24h.'),
			limit: Limit.optional().describe('Top-N builders to return. Default 20.')
		}
	}, async (params) => {
		return asContent(await getBuilderLeaderboard({
			...params,
			_shadowPath: shadowPath,
			_ttlMs: ttlMs
		}));
	});

	server.registerTool('seneschal_stats_overview', {
		title: 'Public stats overview',
		description: 'Aggregate snapshot powering the public stats dashboard at stats.seneschal.space: total positions tracked, debt under watch, HF distribution histogram, top-10 at-risk borrowers, 30-day liquidations-per-day series, builder market share for 24h/7d/30d windows, and 10 most recent on-chain liquidations. One call returns everything needed to render the dashboard.',
		inputSchema: {}
	}, async () => {
		return asContent(await getStatsOverview(db, {
			_shadowPath: shadowPath,
			_sparkPath: sparkPath,
			_ttlMs: ttlMs
		}));
	});

	server.registerTool('seneschal_paywall_info', {
		title: 'Paywall / x402 metadata',
		description: 'Returns the protocol, network, recipient address, and per-call price for every gated endpoint on this data backend. Free to call. Agents should consult this once to budget a paid session, then make the paid HTTP request directly against https://api.seneschal.space/v1/premium/opportunities with an x402 PAYMENT-SIGNATURE header (see https://docs.x402.org).',
		inputSchema: {}
	}, async () => {
		return asContent(paywallSummary ?? { enabled: false, reason: 'X402_RECIPIENT_ADDRESS not set' });
	});

	// Premium feed. Surfaced as an MCP tool for discoverability, but
	// the tool itself answers a paywall-style 503/402 unless the
	// operator has wired up an x402 recipient address. We can't take
	// payment over MCP today (the streaming transport has no clean
	// place to surface PAYMENT-REQUIRED), so the tool's job is to
	// describe what the paid REST endpoint will return and how to
	// pay for it — actual data delivery goes through the REST surface.
	server.registerTool('seneschal_premium_opportunities', {
		title: 'Premium opportunity feed (paid)',
		description: 'Top at-risk borrowers across Aave + Morpho + Spark, annotated with realised 7d market intel (top liquidators, win rate, our own attempt outcomes) and ranked by expected liquidation value. Behind an x402 paywall: free agents see a paywall stub describing how to pay; paying agents fetch the full feed at https://api.seneschal.space/v1/premium/opportunities. Use seneschal_paywall_info to inspect the price/network/recipient before opening a session.',
		inputSchema: {
			since_ms: IntegerString.optional().describe('Lookback window start (epoch ms). Defaults to now − 7d.'),
			min_debt_usd: NumericString.optional().describe('Minimum debt-USD to include. Defaults to 0.'),
			limit: Limit.optional().describe('Maximum opportunities returned (1..500). Defaults to 200.'),
			liquidation_bonus: NumericString.optional().describe('Override the assumed liquidation bonus (e.g. 0.05 for 5%). Defaults to 0.06.')
		}
	}, async (params) => {
		if (!x402Cfg.enabled) {
			return asContent({
				paywall: paywallSummary ?? { enabled: false, reason: 'X402_RECIPIENT_ADDRESS not set' },
				message: 'Premium feed not configured on this server. Use the free seneschal_list_at_risk_borrowers tool, or run your own data-api with X402_RECIPIENT_ADDRESS set.'
			});
		}
		// For agents calling this tool *over MCP*, we still serve the
		// data — MCP transports don't currently negotiate payment, so
		// gating here would block legitimate agent traffic that has
		// no other way in. The HTTP /v1/premium/* surface is the
		// paid one; this MCP tool stays free until the spec lands a
		// transport-level 402.
		return asContent(getPremiumOpportunities(db, params));
	});

	// Premium builder-stats tool — same data as
	// /v1/premium/builder-stats. Useful for agents tuning bundle
	// pricing: "what value do I need to outbid builder X right now?".
	server.registerTool('seneschal_premium_builder_stats', {
		title: 'Premium per-builder bid distribution (paid)',
		description: 'Per-builder bid distribution (p25/median/p75/p90/p99/max ETH) and a 24-element hourly slot histogram over a configurable window. Sourced from the Seneschal shadow recorder so it covers every observed slot, not just landed blocks. Behind an x402 paywall at the REST surface; this MCP tool serves the data directly to authenticated agents.',
		inputSchema: {
			window_ms: IntegerString.optional().describe('Lookback window in milliseconds. Defaults to 7 days. Clamped to [1h, 30d].'),
			limit: Limit.optional().describe('Max builders returned (1..100). Defaults to 25.')
		}
	}, async (params) => {
		if (!x402Cfg.enabled) {
			return asContent({
				paywall: paywallSummary ?? { enabled: false, reason: 'X402_RECIPIENT_ADDRESS not set' },
				message: 'Premium builder-stats not configured on this server. Use the free seneschal_builder_leaderboard tool for slot counts and share, or run your own data-api with X402_RECIPIENT_ADDRESS set.'
			});
		}
		return asContent(await getPremiumBuilderStats({
			window_ms: params.window_ms,
			limit: params.limit,
			_shadowPath: shadowPath
		}));
	});

	// Penny Oracle dispatcher — exposes the entire /v1/q/* family as
	// a single MCP tool. The HTTP surface is paywalled per-call at
	// $0.001 via x402; this MCP tool returns the data directly to
	// authenticated agents (free transport, paid HTTP). The catalogue
	// of supported `question` values is the QUESTION_REGISTRY keys.
	const allQuestions = [
		...Object.keys(QUESTION_REGISTRY),
		...Object.keys(CHAIN_QUESTION_REGISTRY)
	];
	server.registerTool('seneschal_q', {
		title: 'Penny Oracle: atomic single-fact endpoints (DeFi + privacy chains)',
		description: `Atomic single-fact endpoints designed for tight agent loops. Each answers ONE yes/no or one number — sub-50ms, flat $0.001/call at the REST surface. Two families: (1) DeFi facts sourced from our SQLite + shadow-blocks recorder (${Object.keys(QUESTION_REGISTRY).join(', ')}); (2) privacy-chain facts sourced from Seneschal-operated full nodes — Monero (${Object.keys(CHAIN_QUESTION_REGISTRY).filter(k => k.startsWith('xmr/')).join(', ')}) and Zcash (${Object.keys(CHAIN_QUESTION_REGISTRY).filter(k => k.startsWith('zec/')).join(', ')}). Consult /v1/q for per-question input lists and live chain availability.`,
		inputSchema: {
			question: z.enum(allQuestions).describe('Which atomic fact to ask. See description for the list. Privacy-chain questions use `xmr/<name>` or `zec/<name>`.'),
			params: z.record(z.any()).optional().describe('Per-question parameter object. DeFi questions take addr/protocol/window/builder/pct/etc. Privacy-chain questions currently take no params.')
		}
	}, async ({ question, params }) => {
		try {
			if (Object.prototype.hasOwnProperty.call(CHAIN_QUESTION_REGISTRY, question)) {
				const meta = CHAIN_QUESTION_REGISTRY[question];
				if (!chainRpcConfigured[meta.chain]) {
					return asContent({
						error: {
							code: 'chain_not_configured',
							message: `${meta.chain.toUpperCase()} RPC is not configured on this server.`,
							chain: meta.chain
						}
					});
				}
				const result = await chainCache.get(`q:${question}`, () =>
					dispatchChainQuestion({ name: question, deps: chainDeps, rpcUrls: chainRpcUrls })
				);
				return asContent(result);
			}
			const result = await dispatchQuestion({
				name: question,
				params: params ?? {},
				db,
				shadowPath
			});
			return asContent(result);
		} catch (err) {
			return asContent({
				error: {
					code: 'q_validation',
					message: err?.message ?? String(err),
					question,
					available: allQuestions
				}
			});
		}
	});

	// Private watch — view-key payment monitoring for Monero/Zcash.
	// We mirror the REST POST handler: validate input, encrypt the
	// view key, create a row, return the token + secret. The watch
	// itself is driven by the standalone systemd poller; agents see
	// the deliveries on their own webhook URL.
	const privateWatchEnabled = Boolean(config.privateWatchEncryptionKey);
	let watchDb = options.watchDb ?? null;
	let watchMasterKey = options.watchMasterKey ?? null;
	let nfptClient = options.nfptClient ?? null;
	if (privateWatchEnabled && options.disablePrivateWatch !== true) {
		try { watchMasterKey = watchMasterKey ?? parseMasterKey(config.privateWatchEncryptionKey); }
		catch { watchMasterKey = null; }
		try { watchDb = watchDb ?? openWatchDb(options.watchDbPath ?? config.privateWatchDbPath); }
		catch { watchDb = null; }
		nfptClient = nfptClient ?? createNfptClient({
			baseUrl: config.nfptBaseUrl,
			apiKey: config.nfptApiKey,
			timeoutMs: config.nfptTimeoutMs,
			fetchImpl: options.fetchImpl ?? globalThis.fetch
		});
	}
	const privateWatchReady = () => Boolean(watchDb && watchMasterKey && nfptClient);

	server.registerTool('seneschal_private_watch_info', {
		title: 'Private watch — service metadata',
		description: 'Returns the current price, supported chains, NFPT upstream health, and security notes for the view-key payment-monitoring service. Free to call.',
		inputSchema: {}
	}, async () => {
		const nfptHealth = privateWatchReady()
			? await nfptHealthCheck(nfptClient).catch((err) => ({ ok: false, reason: err?.message ?? String(err) }))
			: { ok: false, reason: 'private watch disabled on this server' };
		return asContent(buildPrivateInfo({
			x402Cfg,
			nfptHealth,
			requireHttps: config.privateWatchRequireHttps && !config.privateWatchAllowPrivateWebhooks
		}));
	});

	server.registerTool('seneschal_private_watch_create', {
		title: 'Create a Monero/Zcash payment watch (paid via x402 at REST)',
		description: `Subscribe a Monero or Zcash address to view-key-based payment monitoring. The watch runs on a prepaid credit meter (${WATCH_CONSTANTS.DAY_RATE_ATOMIC} atomic USDC per day idle + ${WATCH_CONSTANTS.CALL_RATE_ATOMIC} per webhook delivered). Creation at the REST surface (POST /v1/private/watch) is paywalled at $0.10 via x402 and seeds the watch with $0.10 of credit. Receiver gets HMAC-signed webhooks plus a 'credit' block on every body; a 'low_credit' warning fires once before the meter expires. Top up via /v1/private/topup, topup-1, or topup-5. View keys are AES-256-GCM encrypted at rest.`,
		inputSchema: {
			chain: z.enum(['monero', 'zcash']).describe('Which privacy chain to monitor.'),
			address: z.string().min(1).describe('Public address for the chain. Monero: standard 95-char base58. Zcash: u1*, t1*, t3*, zs1*.'),
			viewKey: z.string().min(1).describe('Monero: 64-hex private view key. Zcash: UFVK starting with uview1.'),
			webhookUrl: z.string().min(1).describe('HTTPS endpoint we POST signed webhooks to. Private RFC1918/localhost addresses are rejected.'),
			birthdayHeight: z.number().int().nonnegative().optional().describe('Block height the wallet was created at. Monero: scans forward from this height. Zcash: defaults to NU6 (3_042_000) if unspecified.')
		}
	}, async (params) => {
		if (!privateWatchReady()) {
			return asContent({
				error: {
					code: 'private_watch_not_configured',
					message: 'PRIVATE_WATCH_ENCRYPTION_KEY or PRIVATE_WATCH_DB not configured on this server.'
				}
			});
		}
		let input;
		try {
			input = await resolveAndValidateWatchRequest(params, {
				allowPrivateWebhooks: config.privateWatchAllowPrivateWebhooks,
				requireHttps: config.privateWatchRequireHttps && !config.privateWatchAllowPrivateWebhooks
			});
		}
		catch (err) {
			return asContent({
				error: { code: 'invalid_request', message: err?.message ?? String(err) }
			});
		}
		const health = await nfptHealthCheck(nfptClient).catch((err) => ({ ok: false, reason: err?.message ?? String(err) }));
		if (!health?.ok) {
			return asContent({
				error: { code: 'nfpt_upstream_unavailable', message: 'Upstream NFPT scanner not reachable.', nfpt: health }
			});
		}
		const viewKeyCiphertext = encryptViewKey(input.viewKey, watchMasterKey);
		const webhookSecret = generateWebhookSecret();
		const created = storeCreateWatch(watchDb, {
			chain: input.chain,
			address: input.address,
			viewKeyCiphertext,
			webhookUrl: input.webhookUrl,
			webhookSecret,
			birthdayHeight: input.birthdayHeight,
			creditAtomic: WATCH_CONSTANTS.STARTER_CREDIT_ATOMIC,
			dayRateAtomic: WATCH_CONSTANTS.DAY_RATE_ATOMIC,
			maxLifetimeMs: WATCH_CONSTANTS.MAX_WATCH_LIFETIME_MS,
			nowMs: input.now
		});
		return asContent({
			watchId: created.id,
			watchToken: created.token,
			webhookSecret,
			chain: input.chain,
			address: input.address,
			creditAtomic: String(created.creditAtomic),
			ratePerDayAtomic: String(WATCH_CONSTANTS.DAY_RATE_ATOMIC),
			ratePerCallAtomic: String(WATCH_CONSTANTS.CALL_RATE_ATOMIC),
			expiresAt: new Date(created.expiresAt).toISOString(),
			pollIntervalSec: WATCH_CONSTANTS.DEFAULT_POLL_INTERVAL_SEC,
			signatureHeader: 'X-Seneschal-Signature: sha256=<HMAC-SHA256(webhookSecret, body)>',
			topupEndpoints: {
				'10c': '/v1/private/topup',
				'1usd': '/v1/private/topup-1',
				'5usd': '/v1/private/topup-5'
			},
			note: 'Watch is now active. Top up via the REST surface before the meter drains. Use seneschal_private_watch_topup or POST /v1/private/topup*; status/cancel via REST GET/DELETE /v1/private/watch/:id with header x-watch-token.'
		});
	});

	server.registerTool('seneschal_private_watch_topup', {
		title: 'Top up an existing watch (paid via x402 at REST)',
		description: 'Add prepaid credit to an existing Private Watch. Three tiers — $0.10 (default), $1.00, and $5.00 — each settling at the matching REST path (/v1/private/topup, /topup-1, /topup-5). Credit is in atomic USDC ($0.02/day idle, $0.005/call). This tool returns the URL the agent should POST to with its x402 client; it does NOT settle payment itself.',
		inputSchema: {
			watchId: z.string().min(36).max(36).describe('The watchId returned from seneschal_private_watch_create.'),
			watchToken: z.string().min(1).describe('The watchToken returned from seneschal_private_watch_create (constant-time compared at the REST surface).'),
			tier: z.enum(['10c', '1', '5']).default('10c').describe('Top-up size. 10c = $0.10 (≈5 days idle), 1 = $1.00 (≈50 days), 5 = $5.00 (≈250 days).')
		}
	}, async (params) => {
		const tier = params.tier ?? '10c';
		const path = tier === '10c' ? '/v1/private/topup' : tier === '1' ? '/v1/private/topup-1' : '/v1/private/topup-5';
		const creditAtomic = tier === '10c'
			? WATCH_CONSTANTS.TOPUP_10C_ATOMIC
			: tier === '1'
				? WATCH_CONSTANTS.TOPUP_1_ATOMIC
				: WATCH_CONSTANTS.TOPUP_5_ATOMIC;
		return asContent({
			topup_endpoint: path,
			tier,
			creditAtomic: String(creditAtomic),
			body: { watchId: params.watchId, watchToken: params.watchToken },
			x402_note: 'Post the body to this path with an x402 payment header. The route is paywalled — your client (e.g. @x402/client) settles on Base mainnet then re-POSTs. The handler debits the credit meter only after settlement is verified.'
		});
	});

	server.registerTool('seneschal_private_watch_historical', {
		title: 'One-off historical scan (paid via x402 at REST)',
		description: 'Return all spendable + spent notes for a view key without setting up a watch. The view key never touches our SQLite — it flows through to NFPT in memory only. Use this when you want to reconcile a wallet at a point in time. Priced at $0.50 / call at the REST surface.',
		inputSchema: {
			chain: z.enum(['monero', 'zcash']).describe('Which privacy chain to scan.'),
			address: z.string().min(1).describe('Address whose notes you want.'),
			viewKey: z.string().min(1).describe('Monero: 64-hex private view key. Zcash: UFVK starting with uview1.'),
			birthdayHeight: z.number().int().nonnegative().optional().describe('Skip scanning earlier blocks. Zcash auto-detects when omitted (slower but always correct).'),
			toHeight: z.number().int().nonnegative().optional().describe('Stop scanning at this block height. Defaults to chain tip.'),
			includeNotes: z.boolean().optional().describe('Include a per-note breakdown (value/height/tx_hash/spent) in the response. Default false — totals only.')
		}
	}, async (params) => {
		return asContent({
			historical_endpoint: '/v1/private/historical',
			body: {
				chain: params.chain,
				address: params.address,
				viewKey: params.viewKey,
				birthdayHeight: params.birthdayHeight ?? null,
				toHeight: params.toHeight ?? null,
				includeNotes: params.includeNotes ?? false
			},
			x402_note: 'Post the body to /v1/private/historical with an x402 payment header. View key is held in memory only during the request; nothing about it is logged or persisted.'
		});
	});

	server.registerTool('seneschal_private_watch_derive_viewkey', {
		title: 'Derive a Zcash UFVK from a BIP-39 mnemonic (FREE, rate-limited)',
		description: 'Hands a 12- or 24-word seed phrase to NFPT\'s orchard-scanner CLI, returns the matching UFVK. FREE but rate-limited to 6/minute/IP. Be loud about the security trade-off: the phrase transits our server (no logging, no persistence) but a network observer between you and us would see the bytes. Offline derivation with the orchard-scanner binary on a trusted host is the safer alternative — see https://docs.seneschal.space/derive-locally. A UFVK is read-only; it cannot spend funds.',
		inputSchema: {
			chain: z.enum(['zcash']).describe('Currently only Zcash (Orchard) UFVK derivation is supported; Monero coming later.'),
			phrase: z.string().min(1).describe('12- or 24-word BIP-39 mnemonic.'),
			network: z.enum(['mainnet', 'testnet', 'regtest']).default('mainnet').describe('Zcash network the wallet belongs to.')
		}
	}, async (params) => {
		if (!nfptClient) {
			return asContent({ error: { code: 'nfpt_not_configured', message: 'derive-viewkey requires NFPT_BASE_URL' } });
		}
		let input;
		try { input = validateDeriveRequest(params); }
		catch (err) {
			return asContent({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
		}
		try {
			const result = await deriveUfvk(nfptClient, { mnemonic: input.phrase, network: input.network });
			return asContent({
				chain: input.chain,
				network: input.network,
				word_count: input.wordCount,
				ufvk: result.ufvk,
				sapling_fvk: result.sapling_fvk ?? null,
				transparent_fvk: result.transparent_fvk ?? null,
				WARNING: 'Your seed phrase transited our server over TLS. We do NOT log or persist it, but a network observer between you and us would have seen the bytes. For maximum safety, derive offline using the orchard-scanner binary on a trusted machine.'
			});
		}
		catch (err) {
			return asContent({ error: { code: 'derive_failed', message: err?.message ?? String(err) } });
		}
	});

	server.registerTool('seneschal_flashloan_providers', {
		title: 'Flash loan provider catalogue',
		description: 'Curated catalogue of Ethereum mainnet flash-loan providers (Aave V3, Balancer V2, Morpho Blue, Uniswap V3, FlashBank) with current fee in basis points, contract addresses, qualitative liquidity notes, and per-provider caveats. Helpful for searcher agents picking the cheapest viable provider for a liquidation or arbitrage strategy. The catalogue is editorially open: filter by chain, max fee, or multi-asset support.',
		inputSchema: {
			chain: z.string().optional().describe('Chain key, default "ethereum". Currently only ethereum is catalogued.'),
			max_fee_bps: z.union([z.number(), z.string()]).optional().describe('Drop providers whose flat fee exceeds this in basis points (1 bp = 0.01%).'),
			multi_asset: z.boolean().optional().describe('If true, only return providers that support borrowing multiple assets in a single flash loan.')
		}
	}, async (params) => {
		const filtered = filterProviders({
			chain: params.chain ?? 'ethereum',
			maxFeeBps: params.max_fee_bps != null ? Number(params.max_fee_bps) : null,
			multiAsset: params.multi_asset ?? null
		});
		return asContent({
			providers: filtered,
			total: filtered.length,
			catalogue_size: FLASHLOAN_PROVIDERS.length,
			note: 'Static catalogue. Caller must verify live liquidity per provider before relying on a specific amount.'
		});
	});

	return server;
}

// Static server card for registries that prefer not to (or can't)
// auto-scan via Streamable HTTP — e.g. Smithery's fallback path
// described in https://smithery.ai/docs/build/publish#server-scanning,
// and SEP-1649 well-known discovery.
//
// Kept in sync with registerTools() by reading the tool definitions
// from the server instance at startup. The Caddy layer serves this at
// /.well-known/mcp/server-card.json on mcp.seneschal.space.
export function getStaticServerCard() {
	return {
		serverInfo: {
			name: 'Seneschal Data API',
			version: '0.1.0',
			vendor: 'Seneschal',
			homepage: 'https://seneschal.space'
		},
		authentication: { required: false },
		transport: {
			type: 'streamable-http',
			url: 'https://mcp.seneschal.space/'
		},
		tools: [
			{ name: 'seneschal_health', description: 'Service liveness plus row counts and data-source mtimes.' },
			{ name: 'seneschal_list_at_risk_borrowers', description: 'Borrowers across Aave/Morpho/Spark below max_hf, sorted ascending.' },
			{ name: 'seneschal_list_borrowers', description: 'Generic discovery surface with HF + debt range filters, sort, offset.' },
			{ name: 'seneschal_recent_liquidations', description: 'Recent on-chain liquidation events.' },
			{ name: 'seneschal_get_borrower', description: 'Latest snapshot for one borrower across protocols.' },
			{ name: 'seneschal_get_borrower_history', description: 'Time-series HF traces for one borrower.' },
			{ name: 'seneschal_builder_leaderboard', description: 'Ground-truth Ethereum builder market share.' },
			{ name: 'seneschal_stats_overview', description: 'Aggregate snapshot powering the public stats dashboard.' },
			{ name: 'seneschal_flashloan_providers', description: 'Curated catalogue of mainnet flash-loan providers including FlashBank.' },
			{ name: 'seneschal_paywall_info', description: 'Free metadata describing the x402 paywall (network, recipient, per-call price) for premium endpoints.' },
			{ name: 'seneschal_premium_opportunities', description: 'Top at-risk borrowers ranked by expected value, annotated with realised market intel. Paid via x402 at the REST surface.' },
			{ name: 'seneschal_premium_builder_stats', description: 'Per-builder bid distribution and hourly slot histogram for searcher bundle pricing. Paid via x402 at the REST surface.' },
			{ name: 'seneschal_q', description: 'Penny Oracle dispatcher — atomic single-fact endpoints across DeFi (liquidatable, at-risk-count, top-builder, builder-share, builder-bid, recent-liquidations, cheapest-flashloan, data-freshness) and privacy chains (xmr/height, xmr/mempool, xmr/fee, xmr/last-block, zec/height, zec/mempool, zec/last-block). All priced at $0.001/call at the REST surface.' },
			{ name: 'seneschal_private_watch_info', description: 'Free metadata for the view-key payment-watch service: pricing meter, supported chains, NFPT upstream health, security notes.' },
			{ name: 'seneschal_private_watch_create', description: 'Subscribe an XMR/ZEC address (with view key) to webhook-delivered payment monitoring. Prepaid credit meter ($0.02/day + $0.005/call). $0.10 creation via x402 at the REST surface.' },
			{ name: 'seneschal_private_watch_topup', description: 'Returns the URL + body the agent should POST to (with an x402 payment) to top up an existing watch. Three tiers: $0.10, $1, $5.' },
			{ name: 'seneschal_private_watch_historical', description: 'Returns the URL + body for a one-off paid scan (POST /v1/private/historical at $0.50) returning spendable + spent notes for a view key. View key NEVER persists.' },
			{ name: 'seneschal_private_watch_derive_viewkey', description: 'FREE, rate-limited Zcash UFVK derivation from a BIP-39 mnemonic via NFPT\'s orchard-scanner CLI. Loud security warning about phrase transit.' }
		],
		resources: [],
		prompts: []
	};
}

// HTTP listener creating a fresh stateless transport per request.
// This is the recommended pattern from the MCP SDK docs for stateless
// public servers — no session affinity required, trivial to put
// multiple processes behind Caddy.
export function startMcpHttpServer(options = {}) {
	const port = options.port ?? config.mcpPort;
	const host = options.host ?? config.mcpHost;
	const buildServer = options.buildServer ?? buildMcpServer;

	const server = http.createServer(async (req, res) => {
		// CORS for browser-based agents. Permissive: this is a read-only
		// public service.
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'content-type,mcp-session-id,mcp-protocol-version');
		res.setHeader('Access-Control-Max-Age', '86400');
		if (req.method === 'OPTIONS') {
			res.writeHead(204).end();
			return;
		}

		// Built-in health (Caddy probes / monitoring).
		if (req.url === '/health' && req.method === 'GET') {
			res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
			return;
		}

		// MCP discovery via SEP-1649 static server card. Used by
		// registry scanners (Smithery, Glama, etc.) that don't want to
		// run a full MCP initialize() to enumerate tools.
		if (req.url === '/.well-known/mcp/server-card.json' && req.method === 'GET') {
			res.writeHead(200, {
				'content-type': 'application/json',
				'cache-control': 'public, max-age=300'
			});
			res.end(JSON.stringify(getStaticServerCard(), null, '\t'));
			return;
		}

		// MCP root: only POST /, GET /, DELETE / are valid per the spec.
		if (req.url !== '/' && req.url !== '/mcp') {
			res.writeHead(404, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32_004, message: 'route not found' }, id: null }));
			return;
		}

		try {
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: true
			});
			const mcp = buildServer();
			// Clean up after the response so connections don't leak.
			res.on('close', () => {
				transport.close().catch(() => {});
				mcp.close().catch(() => {});
			});
			await mcp.connect(transport);
			await transport.handleRequest(req, res);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error('mcp request failed:', err);
			if (!res.headersSent) {
				res.writeHead(500, { 'content-type': 'application/json' });
				res.end(JSON.stringify({
					jsonrpc: '2.0',
					error: { code: -32_603, message: 'internal error', data: err?.message },
					id: randomUUID()
				}));
			}
		}
	});

	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, host, () => resolve(server));
	});
}
