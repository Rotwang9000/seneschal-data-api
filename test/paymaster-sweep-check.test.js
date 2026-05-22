// Unit tests for scripts/paymaster-sweep-check.mjs. Pure-function
// coverage only; the actual RPC read path is exercised at deploy time
// (`systemctl start seneschal-paymaster-sweep-check.service` immediately
// after install) and through manual journalctl inspection.

import { describe, test, expect } from '@jest/globals';
import {
	classifyBalance,
	summariseBalances,
	DUST_USD,
	ALERT_USD,
	TOKENS
} from '../scripts/paymaster-sweep-check.mjs';

const USDC = TOKENS.find((t) => t.symbol === 'USDC');
const DAI = TOKENS.find((t) => t.symbol === 'DAI');
const CBBTC = TOKENS.find((t) => t.symbol === 'cbBTC');

describe('classifyBalance', () => {
	test('zero balance is not sweep-eligible', () => {
		const entry = classifyBalance(USDC, 0n);
		expect(entry.ok).toBe(true);
		expect(entry.symbol).toBe('USDC');
		expect(entry.usd).toBe(0);
		expect(entry.sweep_eligible).toBe(false);
	});

	test('balance just below dust floor is not eligible', () => {
		// USDC has 6 decimals. $4.99 = 4_990_000 atomic units.
		const entry = classifyBalance(USDC, 4_990_000n);
		expect(entry.usd).toBe(4.99);
		expect(entry.sweep_eligible).toBe(false);
	});

	test('balance at exactly the dust floor is eligible', () => {
		const entry = classifyBalance(USDC, 5_000_000n);
		expect(entry.usd).toBe(5);
		expect(entry.sweep_eligible).toBe(true);
	});

	test('DAI uses 18 decimals and 6-dp rounding', () => {
		// 10 DAI exact.
		const entry = classifyBalance(DAI, 10_000000000000000000n);
		expect(entry.symbol).toBe('DAI');
		expect(entry.human).toBe(10);
		expect(entry.usd).toBe(10);
		expect(entry.sweep_eligible).toBe(true);
	});

	test('cbBTC at non-1 USD price scales correctly', () => {
		// 0.001 cbBTC at $76,000/BTC = $76. 8 decimals → 100_000 atomic.
		const entry = classifyBalance(CBBTC, 100_000n);
		expect(entry.human).toBe(0.001);
		expect(entry.usd).toBe(76);
		expect(entry.sweep_eligible).toBe(true);
	});

	test('custom dust floor overrides DUST_USD', () => {
		// $4.99 at custom dust floor of $1 should now sweep.
		const entry = classifyBalance(USDC, 4_990_000n, { dustUsd: 1 });
		expect(entry.sweep_eligible).toBe(true);
	});
});

describe('summariseBalances', () => {
	test('all-zero feed reports no alert', () => {
		const entries = TOKENS.map((t) => classifyBalance(t, 0n));
		const summary = summariseBalances(entries);
		expect(summary.total_tracked_usd).toBe(0);
		expect(summary.total_sweepable_usd).toBe(0);
		expect(summary.alert).toBe(false);
		expect(summary.alert_threshold_usd).toBe(ALERT_USD);
		expect(summary.dust_floor_usd).toBe(DUST_USD);
	});

	test('alert fires when sweepable crosses the threshold', () => {
		// USDC $40 + DAI $20 = $60 sweepable.
		const entries = [
			classifyBalance(USDC, 40_000_000n),
			classifyBalance(DAI, 20_000000000000000000n)
		];
		const summary = summariseBalances(entries);
		expect(summary.total_sweepable_usd).toBe(60);
		expect(summary.alert).toBe(true);
		expect(summary.hint).toMatch(/scripts\/sweep\.mjs --execute/);
		expect(summary.hint).toMatch(/\$60\.00/);
	});

	test('dust is tracked but not counted as sweepable', () => {
		// $4 USDC = below dust, counted in total_tracked but not sweepable.
		const entries = [classifyBalance(USDC, 4_000_000n)];
		const summary = summariseBalances(entries);
		expect(summary.total_tracked_usd).toBe(4);
		expect(summary.total_sweepable_usd).toBe(0);
		expect(summary.alert).toBe(false);
	});

	test('failed reads are skipped from both totals', () => {
		const entries = [
			{ ok: false, symbol: 'USDC', address: USDC.address, error: 'rpc timeout' },
			classifyBalance(DAI, 60_000000000000000000n)
		];
		const summary = summariseBalances(entries);
		expect(summary.total_tracked_usd).toBe(60);
		expect(summary.total_sweepable_usd).toBe(60);
		expect(summary.alert).toBe(true);
	});

	test('custom alert threshold can be passed in', () => {
		const entries = [classifyBalance(USDC, 10_000_000n)]; // $10
		const tight = summariseBalances(entries, { alertUsd: 5 });
		expect(tight.alert).toBe(true);
		const loose = summariseBalances(entries, { alertUsd: 100 });
		expect(loose.alert).toBe(false);
	});
});
