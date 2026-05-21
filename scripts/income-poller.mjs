#!/usr/bin/env node
// Income time-series poller.
//
// Runs on an hourly systemd timer (seneschal-income-poller.timer) and
// appends one JSON line per run to SENESCHAL_INCOME_SNAPSHOTS
// (default `/var/lib/seneschal-income/snapshots.jsonl`). The REST
// server reads this file read-only via `getIncomeHistory()` to back
// the treasury chart on stats.seneschal.space.
//
// We snapshot rather than scan events because:
// * balance reads are 1-2 RPC calls and run in <1s — perfectly fine
//   for an hourly cron.
// * getLogs / RPC log scans choke on the 30-day window every public
//   Base RPC enforces; an hourly snapshot stream is fundamentally
//   simpler and more durable.
// * the snapshot already captures the only number the dashboard cares
//   about — "did money come in since last hour?".
//
// On failure we still write a `{event:'income_snapshot_failed', …}`
// line so the operator can see *that* the poller fired and *why* it
// couldn't read on-chain — a silent omission would be worse than an
// error breadcrumb.

import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import config from '../src/config.js';
import { buildIncomeConfig, readIncomeSnapshot } from '../src/income.js';

function logJson(obj) {
	process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), ...obj })}\n`);
}

async function appendSnapshotLine(path, line) {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, line + '\n', { encoding: 'utf8', mode: 0o644 });
}

async function main() {
	const incomeCfg = buildIncomeConfig({
		cfg: {
			paymasterAddress: config.paymasterAddress,
			entryPointAddress: config.entryPointAddress,
			baseRpcUrl: config.baseRpcUrl,
			ethUsd: config.ethUsd,
			ethUsdFeed: config.ethUsdFeed,
			x402RecipientAddress: config.x402RecipientAddress
		},
		env: process.env
	});
	if (!incomeCfg.enabled) {
		logJson({ event: 'income_snapshot_skipped', reason: incomeCfg.reason });
		return;
	}
	const snap = await readIncomeSnapshot(incomeCfg);
	logJson({ event: 'income_snapshot', treasury_usd: snap.treasury_usd, eth_float: snap.paymaster?.total_eth_float ?? 0, sweep_eligible_usd: snap.paymaster?.sweep_eligible_usd ?? 0, recipient_usdc: snap.recipient?.usdc_balance ?? 0 });
	// One-line, append-only — JSONL so it can be tail-truncated and
	// streamed without parsing the whole file. Each entry is
	// self-contained (no inter-line schema) so future format changes
	// are non-breaking.
	const line = JSON.stringify({
		t_ms: snap.as_of_ms,
		treasury_usd: snap.treasury_usd ?? 0,
		paymaster: snap.paymaster ? {
			eth_float: snap.paymaster.total_eth_float,
			eth_float_usd: snap.paymaster.total_eth_float_usd,
			token_usd: snap.paymaster.total_token_usd,
			sweep_eligible_usd: snap.paymaster.sweep_eligible_usd
		} : null,
		recipient: snap.recipient ? {
			usdc_balance: snap.recipient.usdc_balance
		} : null
	});
	await appendSnapshotLine(config.incomeSnapshotsPath, line);
}

main().catch((err) => {
	logJson({ event: 'income_snapshot_failed', error: err?.message ?? String(err) });
	// Exit 0 so a transient RPC blip doesn't poison the systemd timer
	// (which would otherwise treat repeated failure as a degraded
	// state and amplify it via Restart=on-failure). The journalctl
	// breadcrumb is the operator's signal.
	process.exit(0);
});
