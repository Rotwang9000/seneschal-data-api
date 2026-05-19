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
			'seneschal_premium_opportunities',
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
