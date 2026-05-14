// End-to-end smoke test: real Streamable HTTP MCP client against the
// live mcp.seneschal.space endpoint. Runs every tool with sample
// arguments and prints a short summary of each response.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL('https://mcp.seneschal.space/');
const transport = new StreamableHTTPClientTransport(url);
const client = new Client({ name: 'seneschal-live-smoke', version: '0.1.0' });

console.log(`connecting to ${url} …`);
await client.connect(transport);
console.log('  connected');

const tools = await client.listTools();
console.log(`tools/list → ${tools.tools.length} tools:`);
for (const t of tools.tools) console.log(`  • ${t.name}`);
console.log();

async function callAndSummarise(name, args, summarise) {
	const r = await client.callTool({ name, arguments: args });
	if (r.isError) throw new Error(`${name} returned isError=true: ${JSON.stringify(r)}`);
	const data = JSON.parse(r.content[0].text);
	console.log(`tools/call ${name}(${JSON.stringify(args)}) →`);
	for (const line of summarise(data)) console.log(`  ${line}`);
	console.log();
	return data;
}

await callAndSummarise('seneschal_health', {}, d => [
	`status=${d.status}, version=${d.version}`,
	`tables: snapshots=${d.tables.borrower_snapshots}, history=${d.tables.aave_borrower_history}, missed=${d.tables.missed_liquidations}`,
	`shadow age: ${Math.round((Date.now() - d.json_sources.shadow_blocks_mtime_ms) / 1000)}s`
]);

await callAndSummarise('seneschal_list_at_risk_borrowers', {
	protocol: 'aave',
	max_hf: 1.05,
	min_debt_usd: 1000,
	limit: 3
}, d => [
	`${d.result_count} results, has_more=${d.has_more}`,
	...d.results.slice(0, 3).map(r => `${r.borrower} hf=${r.health_factor.toFixed(4)} debt=$${(r.debt_usd ?? 0).toLocaleString()}`)
]);

await callAndSummarise('seneschal_recent_liquidations', { limit: 3 }, d => [
	`${d.result_count} results, has_more=${d.has_more}`,
	...d.results.slice(0, 3).map(r => `${r.outcome} ${r.tx_hash?.slice(0, 12)}… debt=$${(r.debt_usd ?? r.actual_profit_usd ?? 0).toLocaleString()}`)
]);

await callAndSummarise('seneschal_builder_leaderboard', { window: '24h', limit: 5 }, d => [
	`${d.total_slots} slots in ${d.window}, cached=${d.cached}`,
	...d.builders.slice(0, 5).map(b => `${b.builder.padEnd(20)} ${b.share_pct.toFixed(2)}%  ${b.total_mev_eth.toFixed(2)} ETH MEV`)
]);

// Look up a real at-risk Aave borrower then fetch history.
const atrisk = await callAndSummarise('seneschal_list_at_risk_borrowers', {
	protocol: 'aave',
	max_hf: 99,
	min_debt_usd: 10000,
	limit: 1
}, d => [`pick ${d.results[0]?.borrower ?? '(none)'}`]);

const target = atrisk.results[0]?.borrower;
if (target) {
	await callAndSummarise('seneschal_get_borrower', { address: target }, d => [
		`found_in: ${d.found_in.join(', ') || '(none)'}`,
		d.aave ? `aave HF=${d.aave.health_factor.toFixed(4)}, debt=$${(d.aave.debt_usd ?? 0).toLocaleString()}` : 'no aave'
	]);

	await callAndSummarise('seneschal_get_borrower_history', {
		address: target,
		protocol: 'aave',
		granularity: 'day',
		limit: 7
	}, d => [
		`${d.point_count} points, granularity=${d.granularity}`,
		...d.points.slice(0, 3).map(p => `t=${new Date(p.timestamp_ms).toISOString().slice(0,10)}  hf=${p.health_factor?.toFixed(4) ?? '?'}`)
	]);
}

await client.close();
console.log('all six tools exercised successfully');
