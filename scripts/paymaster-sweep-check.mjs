#!/usr/bin/env node
// Read-only paymaster sweep-eligibility check.
//
// Runs on a daily systemd timer (seneschal-paymaster-sweep-check.timer)
// and logs accrued paymaster balances per token, plus a single
// summary line. No private key is touched and no transactions are
// sent — the actual sweep is still a deliberate manual action with
// the owner key on the operator machine. This script exists so the
// operator can monitor paymaster revenue at a glance via `journalctl
// -u seneschal-paymaster-sweep-check` without standing up a separate
// data pipeline.
//
// Token list + dust floor are duplicated from scripts/sweep.mjs in
// the paymaster repo intentionally — the paymaster repo is not
// deployed onto fin4. If a token is added there, mirror it here.
// Worst case if forgotten: this script under-reports by missing the
// new token until it's manually added; the on-chain sweep itself is
// still correct.

import { createPublicClient, http, parseAbi, formatUnits } from 'viem';
import { base } from 'viem/chains';

export const PAYMASTER = '0xb6E8d189285003cF0000388b01BA0C3433ee9f14';
export const DUST_USD = 5;
export const ALERT_USD = 50;

export const TOKENS = Object.freeze([
	Object.freeze({ symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, usd: 1.0 }),
	Object.freeze({ symbol: 'EURC', address: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', decimals: 6, usd: 1.16 }),
	Object.freeze({ symbol: 'USDT', address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6, usd: 1.0 }),
	Object.freeze({ symbol: 'DAI',  address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18, usd: 1.0 }),
	Object.freeze({ symbol: 'cbBTC', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8, usd: 76_000 })
]);

const ERC20_ABI = parseAbi([
	'function balanceOf(address) view returns (uint256)'
]);

/**
 * Pure: turn a raw bigint balance into the structured entry the
 * summariser expects. Exposed for tests.
 */
export function classifyBalance(token, raw, { dustUsd = DUST_USD } = {}) {
	const human = Number(formatUnits(raw, token.decimals));
	const usdValue = human * token.usd;
	// Round `human` to the smaller of the token's decimals and 8 dp.
	// 8 dp is enough to show meaningful precision for cbBTC at $76k
	// (~0.0008 USD per unit) without overflowing the JSON line. Tokens
	// like USDC where decimals=6 keep 6 dp, also plenty.
	const displayDp = Math.min(token.decimals, 8);
	return {
		event: 'paymaster_balance',
		symbol: token.symbol,
		address: token.address,
		ok: true,
		human: Number(human.toFixed(displayDp)),
		usd: Number(usdValue.toFixed(2)),
		sweep_eligible: usdValue >= dustUsd
	};
}

/**
 * Pure: aggregate per-balance entries into a single summary record.
 * Exposed for tests.
 */
export function summariseBalances(entries, {
	paymaster = PAYMASTER,
	dustUsd = DUST_USD,
	alertUsd = ALERT_USD
} = {}) {
	let totalTracked = 0;
	let totalSweepable = 0;
	for (const e of entries) {
		if (!e.ok) continue;
		totalTracked += e.usd;
		if (e.sweep_eligible) totalSweepable += e.usd;
	}
	const alert = totalSweepable >= alertUsd;
	return {
		event: 'paymaster_sweep_summary',
		paymaster,
		total_tracked_usd: Number(totalTracked.toFixed(2)),
		total_sweepable_usd: Number(totalSweepable.toFixed(2)),
		dust_floor_usd: dustUsd,
		alert_threshold_usd: alertUsd,
		alert,
		hint: alert
			? `Run scripts/sweep.mjs --execute from the paymaster repo to drain $${totalSweepable.toFixed(2)} of stables to the owner wallet.`
			: 'Below alert threshold; no action required.'
	};
}

async function readBalance(client, token) {
	try {
		const raw = await client.readContract({
			address: token.address,
			abi: ERC20_ABI,
			functionName: 'balanceOf',
			args: [PAYMASTER]
		});
		return classifyBalance(token, raw);
	} catch (err) {
		return {
			event: 'paymaster_balance',
			symbol: token.symbol,
			address: token.address,
			ok: false,
			error: err?.message ?? String(err)
		};
	}
}

function logJson(obj) {
	process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), ...obj })}\n`);
}

async function runOnce({
	rpc = process.env.BASE_RPC_URL || 'https://base-rpc.publicnode.com',
	tokens = TOKENS
} = {}) {
	const client = createPublicClient({ chain: base, transport: http(rpc) });
	const entries = [];
	for (const tok of tokens) {
		const entry = await readBalance(client, tok);
		logJson(entry);
		entries.push(entry);
	}
	const summary = summariseBalances(entries);
	logJson(summary);
	return { entries, summary };
}

// Only execute when invoked directly (`node paymaster-sweep-check.mjs`),
// not when imported by the test runner.
const isMain = (() => {
	try {
		const argvFile = process.argv[1] && new URL(`file://${process.argv[1]}`).href;
		return argvFile === import.meta.url;
	} catch {
		return false;
	}
})();

if (isMain) {
	runOnce().catch((err) => {
		logJson({ event: 'paymaster_sweep_check_failed', error: err?.message ?? String(err) });
		process.exit(0);
	});
}

export { runOnce };
