// Penny Oracle — atomic single-fact endpoints under /v1/q/*.
//
// Each function answers one yes/no or one number, takes <50ms, and
// is designed to be safely called in an agent's tight loop. Pricing
// is set in x402.js (`X402_Q_PRICE`, default $0.001). The whole point
// is "tiny, often, sub-cent" — bulky JSON belongs on /v1/premium/*.
//
// Validation throws TypeError so the global Fastify error handler
// surfaces a 400. Output shapes are stable and deliberately flat:
// agents that hit these in a `for` loop don't want nested objects.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { FLASHLOAN_PROVIDERS } from './flashloan-providers.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u;
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const SUPPORTED_PROTOCOLS = Object.freeze(['aave', 'morpho']);
const SUPPORTED_WINDOWS = Object.freeze({ '24h': ONE_DAY_MS, '7d': 7 * ONE_DAY_MS, '30d': 30 * ONE_DAY_MS });
const SUPPORTED_PERCENTILES = Object.freeze([25, 50, 75, 90, 99]);
const SUPPORTED_FRESHNESS_SOURCES = Object.freeze([
	'shadow_blocks',
	'borrower_snapshot',
	'morpho_borrower_snapshot',
	'missed_liquidations',
	'executions'
]);

// ── tiny pure validators ─────────────────────────────────────────
export function requireAddress(value, field = 'addr') {
	const v = ((value ?? '') + '').trim();
	if (!ADDRESS_RE.test(v)) {
		throw new TypeError(`${field}: '${value}' is not a 0x-prefixed 20-byte hex string`);
	}
	return v.toLowerCase();
}

export function requireWindow(value, fallback = '24h') {
	const v = (value ?? fallback).toString().toLowerCase();
	if (!Object.prototype.hasOwnProperty.call(SUPPORTED_WINDOWS, v)) {
		throw new TypeError(`window: '${value}' must be one of ${Object.keys(SUPPORTED_WINDOWS).join('|')}`);
	}
	return v;
}

export function optionalProtocol(value) {
	if (value === undefined || value === null || value === '') return null;
	const v = value.toString().toLowerCase();
	if (!SUPPORTED_PROTOCOLS.includes(v)) {
		throw new TypeError(`protocol: '${value}' must be one of ${SUPPORTED_PROTOCOLS.join('|')}`);
	}
	return v;
}

export function requireNumber(value, field, { min = -Infinity, max = Infinity, fallback } = {}) {
	if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback;
	const n = Number(value);
	if (!Number.isFinite(n)) {
		throw new TypeError(`${field}: '${value}' is not a finite number`);
	}
	if (n < min || n > max) {
		throw new TypeError(`${field}: ${n} must be between ${min} and ${max}`);
	}
	return n;
}

export function requirePercentile(value) {
	const n = requireNumber(value, 'pct', { min: 1, max: 99, fallback: 50 });
	if (!SUPPORTED_PERCENTILES.includes(n)) {
		throw new TypeError(`pct: ${n} must be one of ${SUPPORTED_PERCENTILES.join(',')}`);
	}
	return n;
}

export function requireFreshnessSource(value) {
	const v = (value ?? '').toString().toLowerCase();
	if (!SUPPORTED_FRESHNESS_SOURCES.includes(v)) {
		throw new TypeError(`source: '${value}' must be one of ${SUPPORTED_FRESHNESS_SOURCES.join('|')}`);
	}
	return v;
}

// ── single-fact queries ──────────────────────────────────────────

/**
 * Q1: Is borrower X liquidatable?
 * Returns the lowest-HF row across Aave + Morpho, or {found: false}.
 */
export function qLiquidatable(db, { addr, protocol }) {
	const address = requireAddress(addr);
	const proto = optionalProtocol(protocol);
	const rows = [];
	if (proto === null || proto === 'aave') {
		const row = db.prepare(`
			SELECT 'aave' AS protocol, last_seen_ts, health_factor,
			       total_debt_usd, liquidatable
			FROM borrower_snapshots
			WHERE LOWER(borrower_address) = ?
		`).get(address);
		if (row) rows.push({
			protocol: row.protocol,
			ts_ms: row.last_seen_ts,
			hf: row.health_factor,
			debt_usd: row.total_debt_usd,
			liquidatable: Boolean(row.liquidatable) || (row.health_factor != null && row.health_factor < 1)
		});
	}
	if (proto === null || proto === 'morpho') {
		const morpho = db.prepare(`
			SELECT 'morpho' AS protocol, last_seen_ts, ltv, lltv, debt_usd
			FROM morpho_borrower_snapshots
			WHERE LOWER(borrower_address) = ?
			ORDER BY distance_to_liquidation ASC
			LIMIT 1
		`).get(address);
		if (morpho && morpho.ltv > 0 && morpho.lltv > 0 && morpho.ltv < 1e10) {
			// Convert Morpho LTV/LLTV to a normalised HF-equivalent so
			// callers can compare like-for-like with Aave. HF = LLTV/LTV.
			const hf = morpho.lltv / morpho.ltv;
			rows.push({
				protocol: 'morpho',
				ts_ms: morpho.last_seen_ts,
				hf,
				debt_usd: morpho.debt_usd ?? null,
				liquidatable: hf < 1
			});
		}
	}
	if (rows.length === 0) {
		return { found: false, addr: address, liquidatable: false, hf: null, debt_usd: null, last_seen_ms: null };
	}
	// Pick the row with the lowest HF — that's the operative risk number.
	rows.sort((a, b) => (a.hf ?? Infinity) - (b.hf ?? Infinity));
	const r = rows[0];
	return {
		found: true,
		addr: address,
		protocol: r.protocol,
		liquidatable: Boolean(r.liquidatable),
		hf: r.hf == null ? null : Number(r.hf.toFixed(6)),
		debt_usd: r.debt_usd == null ? null : Number(r.debt_usd.toFixed(2)),
		last_seen_ms: r.ts_ms
	};
}

/**
 * Q2: Count of borrowers below `max_hf` with `debt_usd >= min_debt_usd`.
 */
export function qAtRiskCount(db, { max_hf, min_debt_usd, protocol } = {}) {
	const maxHf = requireNumber(max_hf, 'max_hf', { min: 0, max: 1000, fallback: 1.05 });
	const minDebt = requireNumber(min_debt_usd, 'min_debt_usd', { min: 0, fallback: 0 });
	const proto = optionalProtocol(protocol);
	let count = 0;
	let totalDebtUsd = 0;
	if (proto === null || proto === 'aave') {
		const row = db.prepare(`
			SELECT COUNT(*) AS n, COALESCE(SUM(total_debt_usd), 0) AS d
			FROM borrower_snapshots
			WHERE health_factor IS NOT NULL
			  AND health_factor > 0
			  AND health_factor < ?
			  AND COALESCE(total_debt_usd, 0) >= ?
		`).get(maxHf, minDebt);
		count += row.n;
		totalDebtUsd += row.d;
	}
	if (proto === null || proto === 'morpho') {
		// Morpho rows store ltv/lltv not hf directly. Filter by the
		// hf-equivalent (lltv/ltv) on the way out.
		const rows = db.prepare(`
			SELECT lltv, ltv, debt_usd
			FROM morpho_borrower_snapshots
			WHERE ltv > 0 AND ltv < 1e10 AND lltv > 0
		`).all();
		for (const r of rows) {
			const hf = r.lltv / r.ltv;
			if (hf < maxHf && (r.debt_usd ?? 0) >= minDebt) {
				count += 1;
				totalDebtUsd += r.debt_usd ?? 0;
			}
		}
	}
	return {
		count,
		total_debt_usd: Number(totalDebtUsd.toFixed(2)),
		max_hf: maxHf,
		min_debt_usd: minDebt,
		protocol: proto
	};
}

/**
 * Q3: Count + total debt of liquidations observed in the last N minutes.
 */
export function qRecentLiquidations(db, { since_min, protocol } = {}, { nowMs = Date.now() } = {}) {
	const sinceMin = requireNumber(since_min, 'since_min', { min: 1, max: 24 * 60, fallback: 60 });
	const proto = optionalProtocol(protocol);
	const cutoff = nowMs - sinceMin * 60 * 1000;
	const row = db.prepare(`
		SELECT COUNT(*) AS n, COALESCE(SUM(debt_usd), 0) AS d
		FROM missed_liquidations
		WHERE timestamp >= ?
	`).get(cutoff);
	return {
		count: row.n,
		total_debt_usd: Number(row.d.toFixed(2)),
		since_min: sinceMin,
		// `protocol` is accepted for forward-compat but the underlying
		// table doesn't tag protocol; we surface `protocol: null` so
		// the response shape is identical for both callers.
		protocol: proto
	};
}

/**
 * Q4-Q6: Builder facts from shadow-blocks.jsonl. Three flavours share
 * a single streaming pass — caller picks the projection.
 */
export async function qBuilderFacts({ window, projection, builder, pct }, { shadowPath, nowMs = Date.now() } = {}) {
	const win = requireWindow(window);
	const windowMs = SUPPORTED_WINDOWS[win];
	const cutoff = nowMs - windowMs;
	if (!existsSync(shadowPath)) {
		return { as_of_ms: nowMs, window: win, total_slots: 0, builders: [], note: 'shadow-blocks.jsonl not present' };
	}
	const agg = new Map();
	let totalSlots = 0;
	const stream = createReadStream(shadowPath, { encoding: 'utf8' });
	const rl = createInterface({ input: stream, crlfDelay: Infinity });
	for await (const line of rl) {
		if (!line) continue;
		let d;
		try { d = JSON.parse(line); } catch { continue; }
		if (typeof d.ts_ms !== 'number' || d.ts_ms < cutoff) continue;
		totalSlots++;
		const key = (d.extra_data ?? d.miner ?? 'unknown') + '';
		const existing = agg.get(key) ?? { slots_won: 0, bids: [] };
		existing.slots_won += 1;
		if (projection === 'bid') {
			existing.bids.push(weiStringToEth(d.actual_total_wei));
		}
		agg.set(key, existing);
	}

	if (projection === 'top-builder') {
		if (totalSlots === 0) {
			return { as_of_ms: nowMs, window: win, total_slots: 0, builder: null, share_pct: 0, slots_won: 0 };
		}
		let top = null;
		for (const [name, v] of agg) {
			if (!top || v.slots_won > top.slots_won) top = { builder: name, slots_won: v.slots_won };
		}
		return {
			as_of_ms: nowMs,
			window: win,
			total_slots: totalSlots,
			builder: top.builder,
			slots_won: top.slots_won,
			share_pct: Number((100 * top.slots_won / totalSlots).toFixed(2))
		};
	}

	if (projection === 'share') {
		const wanted = matchBuilder(agg, builder);
		const slotsWon = wanted ? wanted.slots_won : 0;
		return {
			as_of_ms: nowMs,
			window: win,
			total_slots: totalSlots,
			builder: builder ?? null,
			slots_won: slotsWon,
			share_pct: totalSlots > 0 ? Number((100 * slotsWon / totalSlots).toFixed(2)) : 0
		};
	}

	if (projection === 'bid') {
		const wanted = matchBuilder(agg, builder);
		if (!wanted || wanted.bids.length === 0) {
			return {
				as_of_ms: nowMs, window: win, total_slots: totalSlots,
				builder: builder ?? null, samples: 0, pct, value_eth: 0
			};
		}
		const p = requirePercentile(pct);
		const sorted = wanted.bids.slice().sort((a, b) => a - b);
		const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
		return {
			as_of_ms: nowMs,
			window: win,
			total_slots: totalSlots,
			builder: builder ?? null,
			samples: sorted.length,
			pct: p,
			value_eth: Number(sorted[idx].toFixed(9))
		};
	}

	throw new TypeError(`projection: '${projection}' must be one of top-builder|share|bid`);
}

function matchBuilder(agg, requested) {
	if (!requested) throw new TypeError(`builder: must be supplied`);
	const want = requested.toString().toLowerCase();
	// Exact first.
	for (const [name, v] of agg) {
		if (name.toLowerCase() === want) return v;
	}
	// Substring (most user inputs say 'beaver' for 'beaverbuild.org').
	for (const [name, v] of agg) {
		if (name.toLowerCase().includes(want)) return v;
	}
	return null;
}

function weiStringToEth(raw) {
	if (raw === undefined || raw === null) return 0;
	try {
		const wei = typeof raw === 'bigint' ? raw : BigInt(raw);
		return Number(wei) / 1e18;
	} catch { return 0; }
}

/**
 * Q7: Cheapest flash-loan provider for an asset on a chain.
 * Sources from the static FLASHLOAN_PROVIDERS catalogue.
 */
export function qCheapestFlashloan({ asset, chain } = {}) {
	if (!asset || !asset.toString().trim()) throw new TypeError(`asset: must be supplied`);
	const wantedAsset = asset.toString().trim().toUpperCase();
	const wantedChain = (chain ?? 'ethereum').toString().toLowerCase();
	const candidates = FLASHLOAN_PROVIDERS.filter(p => p.chain.toLowerCase() === wantedChain);
	if (candidates.length === 0) {
		return { found: false, asset: wantedAsset, chain: wantedChain, provider: null, fee_bps: null };
	}
	// We don't have a per-asset table in the static catalogue, so we
	// return the chain-cheapest unconditionally. The catalogue's
	// `notable_constraints` field is the right place to encode "USDT
	// not supported", but for v1 we trust the catalogue is asset-agnostic.
	candidates.sort((a, b) => a.fee_bps - b.fee_bps);
	const best = candidates[0];
	return {
		found: true,
		asset: wantedAsset,
		chain: wantedChain,
		provider: best.id,
		fee_bps: best.fee_bps,
		address: best.address
	};
}

/**
 * Q8: Age of the freshest record in the named data source.
 */
export function qDataFreshness(db, { source }, { paths, nowMs = Date.now() } = {}) {
	const src = requireFreshnessSource(source);
	if (src === 'shadow_blocks') {
		const path = paths?.shadowPath;
		if (!path || !existsSync(path)) {
			return { source: src, age_s: null, mtime_ms: null, note: 'file not present' };
		}
		const mtimeMs = statSync(path).mtimeMs;
		return {
			source: src,
			age_s: Math.round((nowMs - mtimeMs) / 1000),
			mtime_ms: Math.round(mtimeMs)
		};
	}
	const tableMap = {
		borrower_snapshot: { table: 'borrower_snapshots', col: 'last_seen_ts' },
		morpho_borrower_snapshot: { table: 'morpho_borrower_snapshots', col: 'last_seen_ts' },
		missed_liquidations: { table: 'missed_liquidations', col: 'timestamp' },
		executions: { table: 'executions', col: 'timestamp' }
	};
	const entry = tableMap[src];
	try {
		const row = db.prepare(`SELECT max(${entry.col}) AS t FROM ${entry.table}`).get();
		const t = row?.t ?? null;
		return {
			source: src,
			age_s: t ? Math.round((nowMs - t) / 1000) : null,
			mtime_ms: t ?? null
		};
	} catch {
		return { source: src, age_s: null, mtime_ms: null, note: 'table missing' };
	}
}

// ── question dispatcher (used by MCP tool + tests) ───────────────
export const QUESTION_REGISTRY = Object.freeze({
	'liquidatable':        { fn: 'qLiquidatable',       inputs: ['addr', 'protocol?'] },
	'at-risk-count':       { fn: 'qAtRiskCount',        inputs: ['max_hf?', 'min_debt_usd?', 'protocol?'] },
	'recent-liquidations': { fn: 'qRecentLiquidations', inputs: ['since_min?', 'protocol?'] },
	'top-builder':         { fn: 'qBuilderFacts',       inputs: ['window?'], projection: 'top-builder' },
	'builder-share':       { fn: 'qBuilderFacts',       inputs: ['builder', 'window?'], projection: 'share' },
	'builder-bid':         { fn: 'qBuilderFacts',       inputs: ['builder', 'pct?', 'window?'], projection: 'bid' },
	'cheapest-flashloan':  { fn: 'qCheapestFlashloan',  inputs: ['asset', 'chain?'] },
	'data-freshness':      { fn: 'qDataFreshness',      inputs: ['source'] }
});

export async function dispatchQuestion({ name, params = {}, db, shadowPath, nowMs = Date.now() }) {
	if (!Object.prototype.hasOwnProperty.call(QUESTION_REGISTRY, name)) {
		throw new TypeError(`question: '${name}' is not registered. Available: ${Object.keys(QUESTION_REGISTRY).join(', ')}`);
	}
	const entry = QUESTION_REGISTRY[name];
	switch (entry.fn) {
		case 'qLiquidatable':       return qLiquidatable(db, params);
		case 'qAtRiskCount':        return qAtRiskCount(db, params);
		case 'qRecentLiquidations': return qRecentLiquidations(db, params, { nowMs });
		case 'qBuilderFacts':       return qBuilderFacts({ ...params, projection: entry.projection }, { shadowPath, nowMs });
		case 'qCheapestFlashloan':  return qCheapestFlashloan(params);
		case 'qDataFreshness':      return qDataFreshness(db, params, { paths: { shadowPath }, nowMs });
		default: throw new Error(`dispatch: unknown impl '${entry.fn}'`);
	}
}
