// Tests for src/income-history.js. Pure functions plus a small
// file-driven path; we use a tempfile so the test never touches the
// live snapshot stream.

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIncomeHistory, bucketSeriesDaily } from '../src/income-history.js';

let tmpDir;
let path;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'seneschal-income-hist-'));
	path = join(tmpDir, 'snapshots.jsonl');
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function lineOf(row) { return JSON.stringify(row) + '\n'; }

describe('readIncomeHistory', () => {
	test('returns enabled:false when path missing', async () => {
		const r = await readIncomeHistory('/no/such/file.jsonl');
		expect(r.enabled).toBe(false);
		expect(r.series).toEqual([]);
	});

	test('parses well-formed rows and filters by sinceMs', async () => {
		const now = Date.now();
		writeFileSync(path, [
			lineOf({ t_ms: now - 3 * HOUR, treasury_usd: 100, paymaster: { eth_float: 0.04, eth_float_usd: 160, token_usd: 0, sweep_eligible_usd: 0 }, recipient: { usdc_balance: 0 } }),
			lineOf({ t_ms: now - 2 * HOUR, treasury_usd: 101, paymaster: { eth_float: 0.04, eth_float_usd: 160, token_usd: 0.5, sweep_eligible_usd: 0 }, recipient: { usdc_balance: 0.5 } }),
			lineOf({ t_ms: now - 1 * HOUR, treasury_usd: 102, paymaster: { eth_float: 0.04, eth_float_usd: 160, token_usd: 1.0, sweep_eligible_usd: 0 }, recipient: { usdc_balance: 1.0 } })
		].join(''));
		const r = await readIncomeHistory(path, { sinceMs: now - 2.5 * HOUR });
		expect(r.enabled).toBe(true);
		expect(r.series).toHaveLength(2);
		expect(r.series[0].treasury_usd).toBe(101);
		expect(r.series[0].paymaster_eth_float).toBe(0.04);
		expect(r.series[1].recipient_usdc).toBe(1.0);
	});

	test('skips malformed lines silently', async () => {
		const now = Date.now();
		writeFileSync(path, [
			'not-json\n',
			'{ broken json\n',
			lineOf({ t_ms: now, treasury_usd: 50 })
		].join(''));
		const r = await readIncomeHistory(path, { sinceMs: 0 });
		expect(r.series).toHaveLength(1);
		expect(r.series[0].treasury_usd).toBe(50);
	});

	test('drops rows missing t_ms', async () => {
		writeFileSync(path, [
			lineOf({ treasury_usd: 50 }),
			lineOf({ t_ms: 'not-a-number', treasury_usd: 99 }),
			lineOf({ t_ms: 1, treasury_usd: 10 })
		].join(''));
		const r = await readIncomeHistory(path, { sinceMs: 0 });
		expect(r.series).toHaveLength(1);
		expect(r.series[0].treasury_usd).toBe(10);
	});
});

describe('bucketSeriesDaily', () => {
	test('returns one row per UTC day, latest-in-day reading', () => {
		const day0 = Math.floor(Date.UTC(2026, 4, 18) / DAY) * DAY;
		const day1 = day0 + DAY;
		const series = [
			{ t_ms: day0 + 1 * HOUR, treasury_usd: 100, paymaster_eth_float: 0.04, paymaster_token_usd: 0, recipient_usdc: 0 },
			{ t_ms: day0 + 8 * HOUR, treasury_usd: 105, paymaster_eth_float: 0.04, paymaster_token_usd: 1, recipient_usdc: 0 },
			{ t_ms: day0 + 23 * HOUR, treasury_usd: 110, paymaster_eth_float: 0.04, paymaster_token_usd: 2, recipient_usdc: 0 },
			{ t_ms: day1 + 1 * HOUR, treasury_usd: 115, paymaster_eth_float: 0.039, paymaster_token_usd: 3, recipient_usdc: 0.5 }
		];
		const daily = bucketSeriesDaily(series);
		expect(daily).toHaveLength(2);
		expect(daily[0].day_ms).toBe(day0);
		expect(daily[0].treasury_usd).toBe(110);
		expect(daily[0].samples).toBe(3);
		expect(daily[1].day_ms).toBe(day1);
		expect(daily[1].treasury_usd).toBe(115);
		expect(daily[1].recipient_usdc).toBe(0.5);
	});

	test('empty series returns empty array', () => {
		expect(bucketSeriesDaily([])).toEqual([]);
		expect(bucketSeriesDaily(null)).toEqual([]);
	});
});
