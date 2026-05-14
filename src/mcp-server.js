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

	const server = new McpServer({
		name: 'seneschal-data',
		version: apiVersion,
		title: 'Seneschal Data',
		description: 'Free, public liquidation + builder telemetry for DeFi (Aave, Morpho, Spark, Compound). No authentication; rate-limited at the Caddy layer.'
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
			{ name: 'seneschal_flashloan_providers', description: 'Curated catalogue of mainnet flash-loan providers including FlashBank.' }
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
