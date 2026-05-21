// MCP server tests. Two layers:
// 1. In-process: build an McpServer + InMemoryTransport, call each tool
//    via the official Client API, assert tool names and outputs match
//    the queries.js results.
// 2. End-to-end HTTP: start the streamable HTTP transport, point the
//    Client's StreamableHTTPClientTransport at it, and verify a real
//    tools/list + tools/call round-trip works.

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { openTestDb } from '../src/db.js';
import { buildMcpServer, startMcpHttpServer } from '../src/mcp-server.js';
import { _resetLeaderboardCacheForTest } from '../src/queries.js';

const ADDR_A = '0x' + 'a'.repeat(40);

let db;
let tmpRoot;
let sparkPath;
let shadowPath;
let morphoPath;
let httpServer;
let serverPort;

beforeAll(async () => {
	db = openTestDb();
	db.prepare(`
		INSERT INTO borrower_snapshots
			(borrower_address, last_seen_ts, block_number, health_factor,
			 total_collateral_usd, total_debt_usd, liquidatable)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run(ADDR_A, 1_700_000_001_000, 25_000_000, 0.99, 100000, 99000, 1);

	tmpRoot = join(tmpdir(), `seneschal-mcp-test-${Date.now()}-${process.pid}`);
	mkdirSync(tmpRoot, { recursive: true });
	sparkPath = join(tmpRoot, 'spark.json');
	morphoPath = join(tmpRoot, 'morpho.json');
	shadowPath = join(tmpRoot, 'shadow.jsonl');
	writeFileSync(sparkPath, JSON.stringify({ savedAt: new Date().toISOString(), count: 0, borrowers: [] }));
	writeFileSync(morphoPath, JSON.stringify({ lastUpdate: 1, chainId: 1, borrowers: {} }));
	writeFileSync(shadowPath, JSON.stringify({
		ts_ms: Date.now() - 600_000,
		extra_data: 'Seneschal/0.1',
		actual_total_wei: '20000000000000000'
	}) + '\n');

	// End-to-end HTTP server on a random free port. The buildServer
	// factory passes the fixture options through for every new
	// stateless transport.
	_resetLeaderboardCacheForTest();
	httpServer = await startMcpHttpServer({
		port: 0,
		host: '127.0.0.1',
		buildServer: () => buildMcpServer({
			db,
			sparkPath,
			morphoPath,
			shadowPath,
			leaderboardTtlMs: 50
		})
	});
	serverPort = httpServer.address().port;
});

afterAll(async () => {
	await new Promise(r => httpServer?.close(r));
	db?.close?.();
	if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe('in-process tool surface', () => {
	test('lists the expected tools', async () => {
		const server = buildMcpServer({ db, sparkPath, morphoPath, shadowPath });
		const [clientT, serverT] = InMemoryTransport.createLinkedPair();
		await server.connect(serverT);
		const client = new Client({ name: 'test-client', version: '0.0.0' });
		await client.connect(clientT);

		const tools = await client.listTools();
		const names = tools.tools.map(t => t.name).sort();
		expect(names).toEqual([
			'seneschal_builder_leaderboard',
			'seneschal_flashloan_providers',
			'seneschal_get_borrower',
			'seneschal_get_borrower_history',
			'seneschal_health',
			'seneschal_list_at_risk_borrowers',
			'seneschal_list_borrowers',
			'seneschal_paywall_info',
			'seneschal_premium_builder_stats',
			'seneschal_premium_opportunities',
			'seneschal_private_watch_create',
			'seneschal_private_watch_derive_viewkey',
			'seneschal_private_watch_historical',
			'seneschal_private_watch_info',
			'seneschal_private_watch_topup',
			'seneschal_q',
			'seneschal_recent_liquidations',
			'seneschal_stats_overview'
		]);
		// Every tool has a description (improves agent discoverability).
		for (const t of tools.tools) {
			expect(typeof t.description).toBe('string');
			expect(t.description.length).toBeGreaterThan(20);
		}
		await client.close();
		await server.close();
	});

	test('seneschal_q routes by question name', async () => {
		const server = buildMcpServer({ db, sparkPath, morphoPath, shadowPath, chainRpcConfigured: { monero: false, zcash: false } });
		const [clientT, serverT] = InMemoryTransport.createLinkedPair();
		await server.connect(serverT);
		const client = new Client({ name: 'test', version: '0' });
		await client.connect(clientT);

		const r = await client.callTool({
			name: 'seneschal_q',
			arguments: { question: 'at-risk-count', params: { max_hf: 1.05 } }
		});
		expect(r.isError).toBeFalsy();
		const data = JSON.parse(r.content[0].text);
		expect(typeof data.count).toBe('number');
		expect(typeof data.total_debt_usd).toBe('number');
		expect(data.max_hf).toBe(1.05);

		const bad = await client.callTool({
			name: 'seneschal_q',
			arguments: { question: 'liquidatable', params: { addr: 'nope' } }
		});
		const errData = JSON.parse(bad.content[0].text);
		expect(errData.error?.code).toBe('q_validation');

		await client.close();
		await server.close();
	});

	test('seneschal_q dispatches to privacy-chain questions', async () => {
		const stubFetch = async (_url, opts) => {
			const body = JSON.parse(opts.body);
			if (body.method === 'get_info') {
				return { ok: true, status: 200, json: async () => ({
					result: { height: 100, target_height: 0, synchronized: true, tx_pool_size: 3 }
				}) };
			}
			throw new Error(`unexpected method ${body.method}`);
		};
		const server = buildMcpServer({
			db, sparkPath, morphoPath, shadowPath,
			chainRpcUrls: { monero: 'http://stub-mon', zcash: null },
			chainRpcConfigured: { monero: true, zcash: false },
			fetchImpl: stubFetch
		});
		const [clientT, serverT] = InMemoryTransport.createLinkedPair();
		await server.connect(serverT);
		const client = new Client({ name: 'test', version: '0' });
		await client.connect(clientT);

		const r = await client.callTool({
			name: 'seneschal_q',
			arguments: { question: 'xmr/height' }
		});
		expect(r.isError).toBeFalsy();
		const data = JSON.parse(r.content[0].text);
		expect(data.chain).toBe('monero');
		expect(data.height).toBe(100);

		const unset = await client.callTool({
			name: 'seneschal_q',
			arguments: { question: 'zec/height' }
		});
		const unsetData = JSON.parse(unset.content[0].text);
		expect(unsetData.error?.code).toBe('chain_not_configured');

		await client.close();
		await server.close();
	});

	test('seneschal_private_watch_create + _info dispatch via MCP', async () => {
		const { openWatchDb } = await import('../src/private-watch-store.js');
		const { createNfptClient } = await import('../src/private-watch-nfpt.js');
		const watchDb = openWatchDb(':memory:');
		const watchMasterKey = Buffer.from('aa'.repeat(32), 'hex');
		const nfptClient = createNfptClient({
			baseUrl: 'http://nfpt',
			apiKey: 'k',
			fetchImpl: async (url) => {
				if (String(url).endsWith('/lightwallet/status')) {
					return { status: 200, text: async () => JSON.stringify({ success: true, data: { lightwallet: { connected: true, blockHeight: 3_400_000 } } }) };
				}
				return { status: 202, text: async () => JSON.stringify({ data: { jobId: 'J', jobToken: 'T' } }) };
			}
		});
		const server = buildMcpServer({
			db, sparkPath, morphoPath, shadowPath,
			watchDb, watchMasterKey, nfptClient,
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
		const [clientT, serverT] = InMemoryTransport.createLinkedPair();
		await server.connect(serverT);
		const client = new Client({ name: 'test', version: '0' });
		await client.connect(clientT);

		const info = await client.callTool({ name: 'seneschal_private_watch_info', arguments: {} });
		const infoData = JSON.parse(info.content[0].text);
		expect(infoData.chains).toEqual(['monero', 'zcash']);
		expect(infoData.pricing.watch_creation).toBe('$0.10');
		expect(infoData.upstream.ok).toBe(true);

		const create = await client.callTool({
			name: 'seneschal_private_watch_create',
			arguments: {
				chain: 'monero',
				address: '4' + 'F'.repeat(94),
				viewKey: '5'.repeat(64),
				webhookUrl: 'https://example.com/hook'
			}
		});
		const createData = JSON.parse(create.content[0].text);
		expect(createData.watchId).toMatch(/^[0-9a-f-]{36}$/u);
		expect(createData.webhookSecret).toMatch(/^[0-9a-f]{64}$/u);
		expect(createData.chain).toBe('monero');

		const bad = await client.callTool({
			name: 'seneschal_private_watch_create',
			arguments: {
				chain: 'monero', address: '4short', viewKey: '5'.repeat(64),
				webhookUrl: 'https://example.com/hook'
			}
		});
		const badData = JSON.parse(bad.content[0].text);
		expect(badData.error?.code).toBe('invalid_request');

		await client.close();
		await server.close();
	});

	test('seneschal_health returns table sizes', async () => {
		const server = buildMcpServer({ db, sparkPath, morphoPath, shadowPath });
		const [clientT, serverT] = InMemoryTransport.createLinkedPair();
		await server.connect(serverT);
		const client = new Client({ name: 'test', version: '0' });
		await client.connect(clientT);

		const r = await client.callTool({ name: 'seneschal_health', arguments: {} });
		expect(r.isError).toBeFalsy();
		const data = JSON.parse(r.content[0].text);
		expect(data.status).toBe('ok');
		expect(data.tables.borrower_snapshots).toBe(1);
		await client.close();
		await server.close();
	});

	test('seneschal_list_at_risk_borrowers accepts a numeric string for max_hf', async () => {
		const server = buildMcpServer({ db, sparkPath, morphoPath, shadowPath });
		const [clientT, serverT] = InMemoryTransport.createLinkedPair();
		await server.connect(serverT);
		const client = new Client({ name: 'test', version: '0' });
		await client.connect(clientT);

		const r = await client.callTool({
			name: 'seneschal_list_at_risk_borrowers',
			arguments: { max_hf: '1.05' }
		});
		expect(r.isError).toBeFalsy();
		const data = JSON.parse(r.content[0].text);
		expect(data.results.length).toBe(1);
		expect(data.results[0].borrower).toBe(ADDR_A);

		await client.close();
		await server.close();
	});

	test('seneschal_get_borrower rejects malformed addresses', async () => {
		const server = buildMcpServer({ db, sparkPath, morphoPath, shadowPath });
		const [clientT, serverT] = InMemoryTransport.createLinkedPair();
		await server.connect(serverT);
		const client = new Client({ name: 'test', version: '0' });
		await client.connect(clientT);

		const r = await client.callTool({
			name: 'seneschal_get_borrower',
			arguments: { address: 'nope' }
		});
		// Tool errors are returned with isError=true, not as RPC errors.
		expect(r.isError).toBe(true);

		await client.close();
		await server.close();
	});
});

describe('end-to-end HTTP transport', () => {
	test('connects via StreamableHTTPClientTransport and lists tools', async () => {
		const url = new URL(`http://127.0.0.1:${serverPort}/`);
		const transport = new StreamableHTTPClientTransport(url);
		const client = new Client({ name: 'e2e-client', version: '0.0.1' });
		await client.connect(transport);

		const tools = await client.listTools();
		expect(tools.tools.map(t => t.name)).toContain('seneschal_health');

		const r = await client.callTool({ name: 'seneschal_health', arguments: {} });
		expect(r.isError).toBeFalsy();
		const data = JSON.parse(r.content[0].text);
		expect(data.status).toBe('ok');

		await client.close();
	});

	test('GET /health is a plain text 200', async () => {
		const r = await fetch(`http://127.0.0.1:${serverPort}/health`);
		expect(r.status).toBe(200);
		const txt = await r.text();
		expect(txt).toBe('ok');
	});

	test('unknown route returns JSON-RPC 404 envelope', async () => {
		const r = await fetch(`http://127.0.0.1:${serverPort}/bogus`);
		expect(r.status).toBe(404);
		const body = await r.json();
		expect(body.error.code).toBeDefined();
	});

	test('GET /.well-known/mcp/server-card.json serves the static card', async () => {
		const r = await fetch(`http://127.0.0.1:${serverPort}/.well-known/mcp/server-card.json`);
		expect(r.status).toBe(200);
		expect(r.headers.get('content-type')).toContain('application/json');
		const body = await r.json();
		expect(body.serverInfo.name).toMatch(/Seneschal/i);
		expect(body.transport.type).toBe('streamable-http');
		expect(body.authentication.required).toBe(false);
		const toolNames = body.tools.map(t => t.name).sort();
		expect(toolNames).toContain('seneschal_flashloan_providers');
		expect(toolNames).toContain('seneschal_stats_overview');
	});
});
