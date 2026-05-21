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
	healthCheck as nfptHealthCheck
} from './private-watch-nfpt.js';
import {
	validateWatchRequest,
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
		return asContent(buildPrivateInfo({ x402Cfg, nfptHealth }));
	});

	server.registerTool('seneschal_private_watch_create', {
		title: 'Create a Monero/Zcash payment watch (paid via x402 at REST)',
		description: `Subscribe a Monero or Zcash address to view-key-based payment monitoring. ${WATCH_CONSTANTS.DEFAULT_DURATION_DAYS}-day monitoring window by default; the receiver gets a HMAC-signed webhook on every balance change. View keys are AES-256-GCM encrypted at rest. The REST surface at POST /v1/private/watch is paywalled at $0.10 via x402; this MCP tool exposes the same functionality so agents already in a paid MCP session can configure their watches without context-switching.`,
		inputSchema: {
			chain: z.enum(['monero', 'zcash']).describe('Which privacy chain to monitor.'),
			address: z.string().min(1).describe('Public address for the chain. Monero: standard 95-char base58. Zcash: u1*, t1*, t3*, zs1*.'),
			viewKey: z.string().min(1).describe('Monero: 64-hex private view key. Zcash: UFVK starting with uview1.'),
			webhookUrl: z.string().min(1).describe('HTTPS endpoint we POST signed webhooks to. Private RFC1918/localhost addresses are rejected.'),
			durationDays: z.number().int().min(WATCH_CONSTANTS.MIN_DURATION_DAYS).max(WATCH_CONSTANTS.MAX_DURATION_DAYS).optional().describe(`Watch lifetime in days. Default ${WATCH_CONSTANTS.DEFAULT_DURATION_DAYS}.`),
			birthdayHeight: z.number().int().nonnegative().optional().describe('Zcash only: block height the wallet was created at. Skips re-scanning earlier blocks. Strongly recommended for Zcash to keep scans fast.')
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
			input = validateWatchRequest(params, {
				allowPrivateWebhooks: config.privateWatchAllowPrivateWebhooks
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
			durationMs: input.durationMs,
			nowMs: input.now
		});
		return asContent({
			watchId: created.id,
			watchToken: created.token,
			webhookSecret,
			chain: input.chain,
			address: input.address,
			expiresAt: new Date(created.expiresAt).toISOString(),
			pollIntervalSec: WATCH_CONSTANTS.DEFAULT_POLL_INTERVAL_SEC,
			signatureHeader: 'X-Seneschal-Signature: sha256=<HMAC-SHA256(webhookSecret, body)>',
			note: 'Watch is now active. Use seneschal_private_watch_info for service metadata; poll status/cancel via REST GET/DELETE /v1/private/watch/:id with header x-watch-token.'
		});
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
			{ name: 'seneschal_private_watch_info', description: 'Free metadata for the view-key payment-watch service: price, supported chains, NFPT upstream health, security notes.' },
			{ name: 'seneschal_private_watch_create', description: 'Subscribe an XMR/ZEC address (with view key) to webhook-delivered payment monitoring. Paid via x402 at the REST surface; mirrored here so agents in a paid MCP session can configure without context-switching.' }
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
