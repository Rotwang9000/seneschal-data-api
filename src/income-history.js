// Income-history reader.
//
// Reads the JSONL file written by scripts/income-poller.mjs and
// returns a structured time series the dashboard can chart. Pure
// streaming parse — never loads the whole file into memory, just
// keeps the last `windowMs` worth of rows. JSONL is append-only so
// reading is lock-free; if a poll is mid-write we'll see a truncated
// final line, ignore it, and pick it up on the next request.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const HARD_MAX_LINES = 10_000; // safety cap; ~14 months at hourly cadence

/**
 * Stream-parse the snapshot JSONL and return rows newer than
 * `since_ms`. Lines that fail JSON.parse (e.g. mid-write truncation,
 * legacy format) are skipped silently — the chart prefers a thinner
 * series to a noisy crash.
 */
export async function readIncomeHistory(path, { sinceMs = Date.now() - DEFAULT_WINDOW_MS, maxLines = HARD_MAX_LINES } = {}) {
	if (!path || !existsSync(path)) {
		return { enabled: false, reason: 'no snapshots yet', series: [] };
	}
	const stat = statSync(path);
	if (!stat.isFile()) {
		return { enabled: false, reason: 'snapshots path is not a file', series: [] };
	}
	const rows = [];
	const stream = createReadStream(path, { encoding: 'utf8' });
	const rl = createInterface({ input: stream, crlfDelay: Infinity });
	for await (const line of rl) {
		if (!line || line.length === 0) continue;
		let row;
		try { row = JSON.parse(line); }
		catch { continue; }
		if (typeof row !== 'object' || row === null) continue;
		if (typeof row.t_ms !== 'number') continue;
		if (row.t_ms < sinceMs) continue;
		rows.push(normaliseRow(row));
		if (rows.length > maxLines) rows.shift();
	}
	rl.close();
	stream.close();
	return {
		enabled: true,
		path,
		since_ms: sinceMs,
		mtime_ms: stat.mtimeMs,
		series: rows
	};
}

function normaliseRow(row) {
	return {
		t_ms: row.t_ms,
		treasury_usd: numberOrNull(row.treasury_usd),
		paymaster_eth_float: row.paymaster ? numberOrNull(row.paymaster.eth_float) : null,
		paymaster_eth_float_usd: row.paymaster ? numberOrNull(row.paymaster.eth_float_usd) : null,
		paymaster_token_usd: row.paymaster ? numberOrNull(row.paymaster.token_usd) : null,
		paymaster_sweep_eligible_usd: row.paymaster ? numberOrNull(row.paymaster.sweep_eligible_usd) : null,
		recipient_usdc: row.recipient ? numberOrNull(row.recipient.usdc_balance) : null
	};
}

function numberOrNull(v) {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Pure: bucket a series into daily aggregates. We keep the max
 * treasury_usd per day rather than the average — for a "is it
 * growing?" chart, the daily peak is the honest signal.
 */
export function bucketSeriesDaily(series) {
	if (!Array.isArray(series) || series.length === 0) return [];
	const byDay = new Map();
	for (const row of series) {
		const day = Math.floor(row.t_ms / 86_400_000) * 86_400_000;
		const agg = byDay.get(day) ?? {
			day_ms: day,
			treasury_usd: row.treasury_usd,
			paymaster_eth_float: row.paymaster_eth_float,
			paymaster_token_usd: row.paymaster_token_usd,
			recipient_usdc: row.recipient_usdc,
			samples: 0
		};
		// Take the last (latest-in-day) reading for each metric.
		agg.treasury_usd = row.treasury_usd ?? agg.treasury_usd;
		agg.paymaster_eth_float = row.paymaster_eth_float ?? agg.paymaster_eth_float;
		agg.paymaster_token_usd = row.paymaster_token_usd ?? agg.paymaster_token_usd;
		agg.recipient_usdc = row.recipient_usdc ?? agg.recipient_usdc;
		agg.samples += 1;
		byDay.set(day, agg);
	}
	return Array.from(byDay.values()).sort((a, b) => a.day_ms - b.day_ms);
}
