// Query layer. Pure functions that take a better-sqlite3 db handle plus
// well-validated params and return plain JSON-serialisable objects.
//
// Both rest-server.js and mcp-server.js import from here so the public
// REST API and the MCP tools have identical semantics.
//
// Conventions:
// - Every function validates its inputs and throws a TypeError on bad
//   shapes (caught by the transport layer and surfaced as 400 / -32602).
// - Every query has an explicit LIMIT. No unbounded scans.
// - Addresses are normalised to lowercase 0x-prefixed before SQL.
// - Timestamps are exposed as `*_ms` (epoch ms) end-to-end.

import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

import config, {
	DEFAULT_LIMIT,
	MAX_LIMIT,
	DEFAULT_HISTORY_GRANULARITY,
	HISTORY_GRANULARITIES,
	SUPPORTED_PROTOCOLS
} from './config.js';
import { readJsonCached, fileMtimeMs } from './db.js';

// ── input validators ──────────────────────────────────────────────────

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const MORPHO_BORROWER_KEY_RE = /^0x[0-9a-f]{40}$/;

function normaliseAddress(addr) {
	if (typeof addr !== 'string') {
		throw new TypeError('address: must be a string');
	}
	const lower = addr.toLowerCase();
	if (!ADDRESS_RE.test(lower)) {
		throw new TypeError(`address: ${addr} is not a 0x-prefixed 20-byte hex string`);
	}
	return lower;
}

function clampLimit(limit, fallback = DEFAULT_LIMIT) {
	if (limit === undefined || limit === null) return fallback;
	const n = Number(limit);
	if (!Number.isFinite(n) || n < 1) {
		throw new TypeError(`limit: ${limit} is not a positive number`);
	}
	return Math.min(Math.floor(n), MAX_LIMIT);
}

function validateProtocol(protocol, allowAll = false) {
	if (protocol === undefined || protocol === null || protocol === '') {
		if (allowAll) return null;
		throw new TypeError(`protocol: required, one of ${SUPPORTED_PROTOCOLS.join(', ')}`);
	}
	const p = String(protocol).toLowerCase();
	if (!SUPPORTED_PROTOCOLS.includes(p)) {
		throw new TypeError(`protocol: ${protocol} not in ${SUPPORTED_PROTOCOLS.join(', ')}`);
	}
	return p;
}

function validateGranularity(g) {
	if (g === undefined || g === null || g === '') return DEFAULT_HISTORY_GRANULARITY;
	const s = String(g).toLowerCase();
	if (!HISTORY_GRANULARITIES.includes(s)) {
		throw new TypeError(`granularity: ${g} not in ${HISTORY_GRANULARITIES.join(', ')}`);
	}
	return s;
}

// ── 1. health ─────────────────────────────────────────────────────────

export function getHealth(db, opts = {}) {
	// Sub-second probe of each table — pulling COUNT(*) on a 150GB DB
	// would be insane. Use the rowid-based optimisation via
	// `SELECT max(rowid)` which is O(log n) thanks to the b-tree.
	const cheapCount = (table) => {
		try {
			const row = db.prepare(`SELECT max(rowid) AS n FROM ${table}`).get();
			return row?.n ?? 0;
		} catch (e) {
			return { error: e.message };
		}
	};
	return {
		status: 'ok',
		service: 'seneschal-data-api',
		version: opts.version ?? '0.1.0',
		now_ms: Date.now(),
		tables: {
			borrower_snapshots: cheapCount('borrower_snapshots'),
			aave_borrower_history: cheapCount('aave_borrower_history'),
			morpho_borrower_snapshots: cheapCount('morpho_borrower_snapshots'),
			missed_liquidations: cheapCount('missed_liquidations'),
			executions: cheapCount('executions')
		},
		json_sources: {
			morpho_borrowers_mtime_ms: opts.morphoMtimeMs ?? null,
			spark_borrowers_mtime_ms: opts.sparkMtimeMs ?? null,
			shadow_blocks_mtime_ms: opts.shadowMtimeMs ?? null
		}
	};
}

// ── 2. list_at_risk_borrowers ─────────────────────────────────────────

// Returns the current snapshot of borrowers across protocols, filtered
// by max health factor and min debt size. "Current" means the latest row
// in `borrower_snapshots` (Aave) and `morpho_borrower_snapshots`.
//
// We don't union the SQL tables — we query each protocol's snapshot
// table independently and merge in JS, because (a) the schemas differ
// slightly, (b) Spark borrowers live in a JSON file the bot writes, and
// (c) it keeps each individual query simple + indexed.
export function listAtRiskBorrowers(db, params = {}) {
	const protocol = validateProtocol(params.protocol, /* allowAll */ true);
	const maxHf = params.max_hf === undefined || params.max_hf === null
		? null
		: Number(params.max_hf);
	if (maxHf !== null && !(Number.isFinite(maxHf) && maxHf > 0)) {
		throw new TypeError(`max_hf: ${params.max_hf} must be a positive number`);
	}
	const minDebt = params.min_debt_usd === undefined || params.min_debt_usd === null
		? 0
		: Number(params.min_debt_usd);
	if (!Number.isFinite(minDebt) || minDebt < 0) {
		throw new TypeError(`min_debt_usd: ${params.min_debt_usd} must be a non-negative number`);
	}
	const limit = clampLimit(params.limit);

	const out = [];

	// Aave (and Compound, which currently shares the table) — protocol
	// filter is best-effort; the snapshot table doesn't store a protocol
	// column, so when the user asks "aave" we return everything in the
	// snapshot table (the writer only fills it from Aave today). We note
	// the limitation in the response metadata.
	if (protocol === null || protocol === 'aave' || protocol === 'compound') {
		const rows = db.prepare(`
			SELECT borrower_address, last_seen_ts, block_number,
			       health_factor, total_collateral_usd, total_debt_usd,
			       liquidatable
			FROM borrower_snapshots
			WHERE health_factor IS NOT NULL
			  AND health_factor > 0
			  AND (? IS NULL OR health_factor < ?)
			  AND (total_debt_usd IS NULL OR total_debt_usd >= ?)
			ORDER BY health_factor ASC
			LIMIT ?
		`).all(maxHf, maxHf, minDebt, limit);
		for (const r of rows) {
			out.push({
				borrower: r.borrower_address,
				protocol: 'aave',
				health_factor: r.health_factor,
				collateral_usd: r.total_collateral_usd,
				debt_usd: r.total_debt_usd,
				liquidatable: Boolean(r.liquidatable),
				last_observed_ms: r.last_seen_ts,
				block_number: r.block_number
			});
		}
	}

	if (protocol === null || protocol === 'morpho') {
		// Morpho stores per-(market, borrower) state with ltv/lltv. We
		// synthesise a health factor as `lltv / ltv` so consumers can
		// filter uniformly (matches the Aave definition: HF > 1 means
		// healthy, HF → 1 means at risk, HF < 1 means liquidatable).
		// `distance_to_liquidation = lltv - ltv` is also exposed.
		//
		// We cap `ltv < 1e10` to drop IEEE Infinity rows the writer
		// emits when a position has collateral_assets = 0 and non-zero
		// debt. Empirically only a handful (single digits at any time)
		// — they're zombies that some liquidator will eventually GC.
		// Real super-liquidatable positions (ltv > 1) still get
		// included; they're rare but legitimate.
		const rows = db.prepare(`
			SELECT market_id, borrower_address, last_seen_ts, block_number,
			       ltv, lltv, debt_usd, distance_to_liquidation
			FROM morpho_borrower_snapshots
			WHERE ltv IS NOT NULL AND ltv > 0 AND ltv < 1e10
			  AND lltv IS NOT NULL AND lltv > 0
			  AND (debt_usd IS NULL OR debt_usd >= ?)
			ORDER BY distance_to_liquidation ASC
			LIMIT ?
		`).all(minDebt, limit * 4);
		// Over-fetch by 4× then filter HF in JS, since we don't have
		// a SQL expression index on `lltv/ltv`. limit*4 caps the
		// work at 2000 rows which is cheap (composite-PK lookup).
		for (const r of rows) {
			const hf = r.lltv / r.ltv;
			if (maxHf !== null && hf >= maxHf) continue;
			out.push({
				borrower: r.borrower_address,
				protocol: 'morpho',
				market_id: r.market_id,
				health_factor: hf,
				collateral_usd: null,
				debt_usd: r.debt_usd,
				ltv: r.ltv,
				lltv: r.lltv,
				distance_to_liquidation: r.distance_to_liquidation,
				liquidatable: hf < 1,
				last_observed_ms: r.last_seen_ts,
				block_number: r.block_number
			});
		}
	}

	// Spark snapshots come from a JSON file that's a plain list of
	// addresses we're WATCHING — no per-borrower HF or debt available.
	// We deliberately don't include Spark rows here because we can't
	// meaningfully apply the `max_hf` / `min_debt_usd` filters; the
	// presence-only data is exposed via `getBorrower` instead.

	out.sort((a, b) => a.health_factor - b.health_factor);
	const trimmed = out.slice(0, limit);
	return {
		as_of_ms: Date.now(),
		filters: { protocol, max_hf: maxHf, min_debt_usd: minDebt, limit },
		results: trimmed,
		result_count: trimmed.length,
		has_more: out.length > limit
	};
}

// ── 2b. listBorrowers — generic discovery endpoint ────────────────────

// More general than listAtRiskBorrowers: allows HF range filtering
// (both bounds), debt range filtering, sorting, and offset-based
// pagination. Designed for agents that want to discover positions
// without knowing addresses in advance.
const BORROWER_SORT_FIELDS = Object.freeze(['health_factor', 'debt_usd', 'collateral_usd', 'last_observed_ms']);

export function listBorrowers(db, params = {}) {
	const protocol = validateProtocol(params.protocol, /* allowAll */ true);
	const minHf = params.min_hf == null ? null : Number(params.min_hf);
	const maxHf = params.max_hf == null ? null : Number(params.max_hf);
	const minDebt = params.min_debt_usd == null ? 0 : Number(params.min_debt_usd);
	const maxDebt = params.max_debt_usd == null ? null : Number(params.max_debt_usd);
	const limit = clampLimit(params.limit);
	const offset = params.offset == null ? 0 : Math.max(0, Math.floor(Number(params.offset)));
	const sortBy = params.sort_by == null ? 'health_factor' : String(params.sort_by);
	if (!BORROWER_SORT_FIELDS.includes(sortBy)) {
		throw new TypeError(`sort_by: ${sortBy} not in ${BORROWER_SORT_FIELDS.join(', ')}`);
	}
	const sortDir = String(params.sort_dir ?? 'asc').toLowerCase();
	if (sortDir !== 'asc' && sortDir !== 'desc') {
		throw new TypeError(`sort_dir: ${sortDir} must be asc or desc`);
	}
	for (const [name, v] of [['min_hf', minHf], ['max_hf', maxHf], ['min_debt_usd', minDebt], ['max_debt_usd', maxDebt]]) {
		if (v != null && !Number.isFinite(v)) {
			throw new TypeError(`${name}: ${params[name]} is not a finite number`);
		}
	}

	const out = [];

	if (protocol === null || protocol === 'aave' || protocol === 'compound') {
		const rows = db.prepare(`
			SELECT borrower_address, last_seen_ts, block_number,
			       health_factor, total_collateral_usd, total_debt_usd,
			       liquidatable
			FROM borrower_snapshots
			WHERE health_factor IS NOT NULL AND health_factor > 0
			  AND (? IS NULL OR health_factor >= ?)
			  AND (? IS NULL OR health_factor <  ?)
			  AND (total_debt_usd IS NULL OR total_debt_usd >= ?)
			  AND (? IS NULL OR total_debt_usd <= ?)
		`).all(minHf, minHf, maxHf, maxHf, minDebt, maxDebt, maxDebt);
		for (const r of rows) {
			out.push({
				borrower: r.borrower_address,
				protocol: 'aave',
				health_factor: r.health_factor,
				collateral_usd: r.total_collateral_usd,
				debt_usd: r.total_debt_usd,
				liquidatable: Boolean(r.liquidatable),
				last_observed_ms: r.last_seen_ts,
				block_number: r.block_number
			});
		}
	}

	if (protocol === null || protocol === 'morpho') {
		// Morpho's HF synthesised from ltv/lltv; debt_usd unreliable
		// so we don't filter on max_debt here (would drop too many).
		const rows = db.prepare(`
			SELECT market_id, borrower_address, last_seen_ts, block_number,
			       ltv, lltv, debt_usd, distance_to_liquidation
			FROM morpho_borrower_snapshots
			WHERE ltv IS NOT NULL AND ltv > 0 AND ltv < 1e10
			  AND lltv IS NOT NULL AND lltv > 0
		`).all();
		for (const r of rows) {
			const hf = r.lltv / r.ltv;
			if (minHf != null && hf < minHf) continue;
			if (maxHf != null && hf >= maxHf) continue;
			out.push({
				borrower: r.borrower_address,
				protocol: 'morpho',
				market_id: r.market_id,
				health_factor: hf,
				collateral_usd: null,
				debt_usd: r.debt_usd,
				ltv: r.ltv,
				lltv: r.lltv,
				distance_to_liquidation: r.distance_to_liquidation,
				liquidatable: hf < 1,
				last_observed_ms: r.last_seen_ts,
				block_number: r.block_number
			});
		}
	}

	const dirMul = sortDir === 'desc' ? -1 : 1;
	out.sort((a, b) => {
		const av = a[sortBy] == null ? Infinity : a[sortBy];
		const bv = b[sortBy] == null ? Infinity : b[sortBy];
		return (av - bv) * dirMul;
	});

	const totalMatched = out.length;
	const page = out.slice(offset, offset + limit);

	return {
		as_of_ms: Date.now(),
		filters: {
			protocol, min_hf: minHf, max_hf: maxHf,
			min_debt_usd: minDebt, max_debt_usd: maxDebt,
			sort_by: sortBy, sort_dir: sortDir, limit, offset
		},
		results: page,
		result_count: page.length,
		total_matched: totalMatched,
		has_more: totalMatched > offset + limit
	};
}

// ── 3. recent_liquidations ────────────────────────────────────────────

// Liquidations we observed in the last N (default 24h). Sources:
// - `missed_liquidations` — every on-chain liquidation we detected,
//   whether we tracked the borrower (`was_tracking`) or not
// - `executions` where success=1 — landings we ourselves won
//
// Returned in descending timestamp order. `outcome` distinguishes the
// two sources so consumers can filter. Note the live writer does not
// store a `protocol` column on missed_liquidations — the table mixes
// every protocol the bot watches. The `protocol` query param is
// therefore ignored for missed events; it still filters `executions`
// by matching the strategy string prefix.
export function recentLiquidations(db, params = {}) {
	const sinceMs = params.since_ms === undefined || params.since_ms === null
		? Date.now() - 24 * 60 * 60 * 1000
		: Number(params.since_ms);
	if (!Number.isFinite(sinceMs) || sinceMs < 0) {
		throw new TypeError(`since_ms: ${params.since_ms} must be a non-negative number`);
	}
	const limit = clampLimit(params.limit);
	const protocol = validateProtocol(params.protocol, true);

	const missed = db.prepare(`
		SELECT tx_hash, timestamp, block_number, borrower_address,
		       liquidator, debt_asset, collateral_asset,
		       debt_to_cover, liquidated_collateral, debt_usd,
		       was_tracking, would_have_been_profitable
		FROM missed_liquidations
		WHERE timestamp >= ?
		ORDER BY timestamp DESC
		LIMIT ?
	`).all(sinceMs, limit);

	// `strategy` typically looks like 'aave_liquidation', 'morpho_…' etc.
	// so a `LIKE protocol||'%'` filter routes the user's `protocol` to
	// matching landings.
	//
	// `success=1 AND tx_hash looks real` — see the comment in
	// getStatsOverview's operator_activity block for why the tx_hash
	// predicate is non-negotiable: a writer-side arg-misalignment used
	// to set success=1 on no-tx skip rows. We've since fixed the writer,
	// but the dashboard must remain robust against any future regression.
	const landings = protocol
		? db.prepare(`
			SELECT timestamp, block_number, strategy, borrower_address,
			       tx_hash, success, actual_profit_usd, gas_used_usd
			FROM executions
			WHERE timestamp >= ?
			  AND success = 1
			  AND tx_hash IS NOT NULL
			  AND tx_hash LIKE '0x%'
			  AND length(tx_hash) = 66
			  AND strategy LIKE ?
			ORDER BY timestamp DESC
			LIMIT ?
		`).all(sinceMs, `${protocol}%`, limit)
		: db.prepare(`
			SELECT timestamp, block_number, strategy, borrower_address,
			       tx_hash, success, actual_profit_usd, gas_used_usd
			FROM executions
			WHERE timestamp >= ?
			  AND success = 1
			  AND tx_hash IS NOT NULL
			  AND tx_hash LIKE '0x%'
			  AND length(tx_hash) = 66
			ORDER BY timestamp DESC
			LIMIT ?
		`).all(sinceMs, limit);

	const out = [];
	for (const r of missed) {
		out.push({
			outcome: 'won_by_other',
			block_number: r.block_number,
			timestamp_ms: r.timestamp,
			tx_hash: r.tx_hash,
			borrower: r.borrower_address,
			liquidator: r.liquidator ?? null,
			debt_asset: r.debt_asset ?? null,
			collateral_asset: r.collateral_asset ?? null,
			debt_to_cover_raw: r.debt_to_cover ?? null,
			liquidated_collateral_raw: r.liquidated_collateral ?? null,
			debt_usd: r.debt_usd ?? null,
			was_tracking: Boolean(r.was_tracking),
			would_have_been_profitable: Boolean(r.would_have_been_profitable)
		});
	}
	for (const r of landings) {
		out.push({
			outcome: 'we_landed',
			block_number: r.block_number,
			timestamp_ms: r.timestamp,
			tx_hash: r.tx_hash,
			borrower: r.borrower_address,
			strategy: r.strategy ?? null,
			actual_profit_usd: r.actual_profit_usd ?? null,
			gas_used_usd: r.gas_used_usd ?? null
		});
	}
	out.sort((a, b) => b.timestamp_ms - a.timestamp_ms);
	const trimmed = out.slice(0, limit);
	return {
		since_ms: sinceMs,
		filters: { protocol, limit },
		results: trimmed,
		result_count: trimmed.length,
		has_more: out.length > limit
	};
}

// ── 4. get_borrower ───────────────────────────────────────────────────

export function getBorrower(db, params = {}) {
	const address = normaliseAddress(params.address);

	const aaveRow = db.prepare(`
		SELECT last_seen_ts, block_number, health_factor,
		       total_collateral_usd, total_debt_usd, liquidatable
		FROM borrower_snapshots
		WHERE borrower_address = ?
	`).get(address);

	// Borrower can have positions across multiple Morpho markets; return them all.
	const morphoRows = db.prepare(`
		SELECT market_id, last_seen_ts, block_number, ltv, lltv,
		       debt_usd, distance_to_liquidation
		FROM morpho_borrower_snapshots
		WHERE borrower_address = ?
		ORDER BY distance_to_liquidation ASC
	`).all(address);

	const sparkData = params._sparkData
		?? readJsonCached(params._sparkPath ?? '/opt/mevbot/data/spark-borrowers.json');
	// Live spark JSON is a list of bare addresses (strings). We surface
	// presence rather than HF here; the bot itself doesn't store per-
	// borrower HF for Spark in the JSON.
	const sparkTracked = (sparkData?.borrowers && Array.isArray(sparkData.borrowers))
		? sparkData.borrowers.some(b => {
			const s = typeof b === 'string' ? b : b?.address;
			return typeof s === 'string' && s.toLowerCase() === address;
		})
		: false;

	const result = {
		address,
		found_in: [],
		aave: null,
		morpho: null,
		spark: null,
		as_of_ms: Date.now()
	};

	if (aaveRow) {
		result.found_in.push('aave');
		result.aave = {
			health_factor: aaveRow.health_factor,
			collateral_usd: aaveRow.total_collateral_usd,
			debt_usd: aaveRow.total_debt_usd,
			liquidatable: Boolean(aaveRow.liquidatable),
			last_observed_ms: aaveRow.last_seen_ts,
			block_number: aaveRow.block_number
		};
	}
	if (morphoRows.length > 0) {
		result.found_in.push('morpho');
		result.morpho = {
			positions: morphoRows.map(r => ({
				market_id: r.market_id,
				health_factor: r.ltv > 0 ? r.lltv / r.ltv : null,
				ltv: r.ltv,
				lltv: r.lltv,
				debt_usd: r.debt_usd,
				distance_to_liquidation: r.distance_to_liquidation,
				liquidatable: r.ltv > 0 && r.lltv > 0 && r.lltv / r.ltv < 1,
				last_observed_ms: r.last_seen_ts,
				block_number: r.block_number
			}))
		};
	}
	if (sparkTracked) {
		result.found_in.push('spark');
		result.spark = {
			watched: true,
			last_observed_ms: sparkData?.savedAt
				? Date.parse(sparkData.savedAt)
				: null,
			note: 'Spark positions are tracked by address only; per-borrower HF/debt is not retained in the public snapshot.'
		};
	}

	return result;
}

// ── 5. get_borrower_history ───────────────────────────────────────────

// Aave history — full time series at row granularity, OR bucketed to
// hour/day for charts. Morpho history exists too but the writer only
// snapshots when state actually changes, so raw is already sparse.
// Protocols for which history is actually stored as a SQL table. Spark
// has a JSON snapshot only; Compound is currently merged into the aave
// history table by the writer so we don't expose it as a separate
// option here.
const HISTORY_PROTOCOLS = Object.freeze(['aave', 'morpho']);

export function getBorrowerHistory(db, params = {}) {
	const address = normaliseAddress(params.address);
	const protocol = validateProtocol(params.protocol);
	if (!HISTORY_PROTOCOLS.includes(protocol)) {
		throw new TypeError(`protocol: history not available for ${protocol}; supported: ${HISTORY_PROTOCOLS.join(', ')}`);
	}
	const granularity = validateGranularity(params.granularity);
	const sinceMs = params.since_ms === undefined || params.since_ms === null
		? Date.now() - 7 * 24 * 60 * 60 * 1000
		: Number(params.since_ms);
	if (!Number.isFinite(sinceMs) || sinceMs < 0) {
		throw new TypeError(`since_ms: ${params.since_ms} must be a non-negative number`);
	}
	const untilMs = params.until_ms === undefined || params.until_ms === null
		? Date.now()
		: Number(params.until_ms);
	if (!Number.isFinite(untilMs) || untilMs < sinceMs) {
		throw new TypeError(`until_ms: ${params.until_ms} must be >= since_ms`);
	}
	const limit = clampLimit(params.limit, /* fallback */ MAX_LIMIT);

	const bucketMs = granularity === 'hour'
		? 60 * 60 * 1000
		: granularity === 'day'
			? 24 * 60 * 60 * 1000
			: 0;

	// The two history tables have different schemas: Aave stores
	// health_factor / collateral_usd / debt_usd directly; Morpho stores
	// ltv / lltv / debt_usd and we synthesise HF = lltv / ltv on read.
	// Branch the query+row-mapper here rather than trying to shoe-horn
	// both into one prepared statement.
	let rawPoints;
	if (protocol === 'aave') {
		const rows = db.prepare(`
			SELECT timestamp, block_number, health_factor,
			       total_collateral_usd, total_debt_usd, liquidatable
			FROM aave_borrower_history
			WHERE borrower_address = ?
			  AND timestamp BETWEEN ? AND ?
			ORDER BY timestamp ASC
			LIMIT ?
		`).all(address, sinceMs, untilMs, limit);
		rawPoints = rows.map(r => ({
			timestamp_ms: r.timestamp,
			block_number: r.block_number,
			health_factor: r.health_factor,
			collateral_usd: r.total_collateral_usd,
			debt_usd: r.total_debt_usd,
			liquidatable: Boolean(r.liquidatable)
		}));
	} else {
		// protocol === 'morpho'. Includes market_id for disambiguation.
		const rows = db.prepare(`
			SELECT timestamp, block_number, market_id, ltv, lltv,
			       debt_usd, distance_to_liquidation
			FROM morpho_borrower_history
			WHERE borrower_address = ?
			  AND timestamp BETWEEN ? AND ?
			ORDER BY timestamp ASC
			LIMIT ?
		`).all(address, sinceMs, untilMs, limit);
		rawPoints = rows.map(r => ({
			timestamp_ms: r.timestamp,
			block_number: r.block_number,
			market_id: r.market_id,
			health_factor: r.ltv > 0 ? r.lltv / r.ltv : null,
			ltv: r.ltv,
			lltv: r.lltv,
			debt_usd: r.debt_usd,
			distance_to_liquidation: r.distance_to_liquidation,
			liquidatable: r.ltv > 0 && r.lltv > 0 && r.lltv / r.ltv < 1
		}));
	}

	let points;
	if (bucketMs === 0) {
		points = rawPoints;
	} else {
		// Last observation per bucket.
		const buckets = new Map();
		for (const r of rawPoints) {
			const k = Math.floor(r.timestamp_ms / bucketMs) * bucketMs;
			buckets.set(k, { ...r, timestamp_ms: k });
		}
		points = [...buckets.values()].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
	}

	return {
		address,
		protocol,
		granularity,
		since_ms: sinceMs,
		until_ms: untilMs,
		points,
		point_count: points.length
	};
}

// ── 6. builder_leaderboard ────────────────────────────────────────────

// Streams shadow-blocks.jsonl (append-only file the shadow recorder
// writes one line per slot) and aggregates builder market share over the
// requested window. Cached for `leaderboardCacheTtlMs` so we don't
// re-parse 50k lines on every request.
//
// The shadow recorder records the WINNER of each slot (whoever the
// validator picked, not necessarily us), so this is real ground-truth
// market share data — same numbers `relayscan.io` reports but derived
// from our own observations.

const _leaderboardCache = { ts: 0, key: null, value: null };

// Coinbase address → display name. Verified 2026-05-14 against
// relayscan.io's builder leaderboard plus public on-chain attestations.
// Unknown coinbases are surfaced as `unknown-<short>` so operators can
// see which addresses we should be mapping but haven't yet.
const KNOWN_COINBASE_ADDRESSES = Object.freeze({
	'0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97': 'beaverbuild',
	'0xdadb0d80178819f2319190d340ce9a924f783711': 'titan',
	'0x396343362be2a4da1ce0c1c210945346fb82aa49': 'rsync',
	'0xfb74767c1ce1aada0a0e114441173b57f8c1571b': 'BuilderNet',
	'0x388c818ca8b9251b393131c08a736a67ccb19297': 'beaverbuild-bx',
	'0x6420e9c89f54afd58a3a2bdb9a5c9c61e76dbabc': 'jet',
	'0x95222290dd7278aa3ddd389cc1e1d165cc4bafe5': 'beaverbuild-old',
	'0x7e2a2fa2a064f693f0a55c5639476d913ff12d05': 'manifold',
	'0x9fc3da866e7df3a1c57ade1a97c9f00a70f010c8': 'builder0x69',
	'0xa1defa73d502b27c7e9c84cebbfde15c587bcc7d': 'penguinbuild',
	'0xff58d746a67c2e42bcc07d6b3f58406e8837e883': 'bobthebuilder',
	'0x690b9a9e9aa1c9db991c7721a92d351db4fac990': 'builderhood',
	'0x3b64216ad1a58f61538b4fa1b27327675ab7ed67': 'quasar',
	'0xea3a0a52ad7a14c5d603f1ec2c9e9c6fc1d3b8bf': 'eureka',
	'0xc83ecf08075cb5e8d1ab21c1c47f5e1f02fc1d56': 'btcs',
	'0xb646d87963da1fb9d192ddba775f24f33e857128': 'blockbeelder',
	'0xf2f5c73fa04406b1995e397b55c24ab1f3ea726c': 'flashbots-direct'
});

function builderDisplayName(extraDataOrCoinbase) {
	if (!extraDataOrCoinbase || extraDataOrCoinbase === 'unknown') return 'unknown';
	const lower = String(extraDataOrCoinbase).toLowerCase();
	if (KNOWN_COINBASE_ADDRESSES[lower]) return KNOWN_COINBASE_ADDRESSES[lower];
	// extra_data values (strings like 'beaverbuild.org') get a separate
	// fallback for backward compat with older shadow-blocks lines that
	// did capture extra_data.
	const byExtra = {
		'beaverbuild.org': 'beaverbuild',
		'titanbuilder': 'titan',
		'rsync-builder': 'rsync',
		'jet-builder': 'jet',
		'Seneschal/0.1': 'seneschal'
	}[extraDataOrCoinbase];
	if (byExtra) return byExtra;
	if (lower.startsWith('0x') && lower.length === 42) return `unknown-${lower.slice(0, 10)}`;
	return extraDataOrCoinbase;
}

export async function getBuilderLeaderboard(params = {}) {
	const window = String(params.window ?? '24h').toLowerCase();
	const windowMs = window === '7d' ? 7 * 24 * 60 * 60 * 1000
		: window === '30d' ? 30 * 24 * 60 * 60 * 1000
		: window === 'all' ? Number.POSITIVE_INFINITY
		: 24 * 60 * 60 * 1000;
	const limit = clampLimit(params.limit, 20);
	const shadowPath = params._shadowPath ?? '/opt/mevbot/data/shadow-blocks.jsonl';
	const ttlMs = params._ttlMs ?? 60_000;
	const now = Date.now();
	const cacheKey = `${window}|${shadowPath}`;

	if (_leaderboardCache.key === cacheKey
		&& now - _leaderboardCache.ts < ttlMs
		&& _leaderboardCache.value
	) {
		return { ..._leaderboardCache.value, cached: true };
	}

	if (!existsSync(shadowPath)) {
		return {
			window,
			as_of_ms: now,
			total_slots: 0,
			builders: [],
			cached: false,
			note: 'shadow-blocks.jsonl not present'
		};
	}

	const cutoff = now - windowMs;
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
		// Prefer extra_data (text label) over miner (coinbase address)
		// for display. Older shadow lines only have `miner`.
		const key = d.extra_data ?? d.miner ?? 'unknown';
		const display = builderDisplayName(key);
		const existing = agg.get(display) ?? { slots_won: 0, mev_wei: 0n, fee_recipient: d.miner ?? null };
		existing.slots_won += 1;
		try { existing.mev_wei += BigInt(d.actual_total_wei ?? 0); } catch {}
		agg.set(display, existing);
	}
	const builders = [...agg.entries()]
		.map(([name, v]) => ({
			builder: name,
			fee_recipient: v.fee_recipient,
			slots_won: v.slots_won,
			share_pct: totalSlots > 0 ? +(100 * v.slots_won / totalSlots).toFixed(2) : 0,
			total_mev_eth: Number(v.mev_wei) / 1e18
		}))
		.sort((a, b) => b.slots_won - a.slots_won)
		.slice(0, limit);
	const result = {
		window,
		as_of_ms: now,
		total_slots: totalSlots,
		builders,
		cached: false
	};
	_leaderboardCache.ts = now;
	_leaderboardCache.key = cacheKey;
	_leaderboardCache.value = result;
	return result;
}

export function _resetLeaderboardCacheForTest() {
	_leaderboardCache.ts = 0;
	_leaderboardCache.key = null;
	_leaderboardCache.value = null;
}

// ── 7. stats overview ─────────────────────────────────────────────────

// Bucket boundaries for the at-risk histogram on the public dashboard.
// (0, 0.5] = deeply liquidatable
// (0.5, 0.8] = liquidatable
// (0.8, 1.0] = on the edge
// (1.0, 1.1] = at-risk
// (1.1, 1.5] = stretched
// (1.5, ∞) = comfortable (not surfaced in this list to keep payload small)
const HF_BUCKETS = Object.freeze([
	{ label: '0.0–0.5', min: 0,   max: 0.5 },
	{ label: '0.5–0.8', min: 0.5, max: 0.8 },
	{ label: '0.8–1.0', min: 0.8, max: 1.0 },
	{ label: '1.0–1.1', min: 1.0, max: 1.1 },
	{ label: '1.1–1.5', min: 1.1, max: 1.5 }
]);

// Bundle of summary aggregates used by stats.seneschal.space.
// All inputs are public on-chain so no PII concerns; addresses ARE
// truncated to 0x…last4 in the top-N list because the dashboard's
// audience is humans glancing, not bots scraping (bots use the JSON
// /v1/liquidations/atrisk endpoint directly).
export async function getStatsOverview(db, params = {}) {
	const shadowPath = params._shadowPath ?? '/opt/mevbot/data/shadow-blocks.jsonl';
	const ttlMs = params._ttlMs ?? 60_000;
	// Test-injection seam: tests pass fixture rows with timestamps far
	// in the past, so they pass `_nowMs` (and optionally `_windowMs`) to
	// shift the 24h cutoff onto the fixture. Production always reads
	// the real wall clock.
	const now = params._nowMs ?? Date.now();
	const windowMs = params._windowMs ?? (24 * 60 * 60 * 1000);

	// Cheap row counts — same trick as getHealth: O(log n) via max(rowid).
	const tableSize = (table) => {
		try { return db.prepare(`SELECT max(rowid) AS n FROM ${table}`).get()?.n ?? 0; }
		catch { return 0; }
	};

	const totals = {
		borrower_snapshots: tableSize('borrower_snapshots'),
		aave_borrower_history_rows: tableSize('aave_borrower_history'),
		morpho_borrower_snapshots: tableSize('morpho_borrower_snapshots'),
		missed_liquidations: tableSize('missed_liquidations'),
		executions: tableSize('executions')
	};

	// At-risk Aave totals — covers the bulk of debt. SUM over the
	// snapshot table is index-friendly (idx_snapshot_debt) and cheap.
	const aaveAggregate = db.prepare(`
		SELECT
			COUNT(*) AS positions,
			COALESCE(SUM(total_debt_usd), 0)        AS total_debt_usd,
			COALESCE(SUM(total_collateral_usd), 0)  AS total_collateral_usd
		FROM borrower_snapshots
		WHERE health_factor IS NOT NULL
		  AND health_factor > 0
		  AND total_debt_usd IS NOT NULL
		  AND total_debt_usd > 0
	`).get();

	// HF histogram. NB: morpho_borrower_snapshots.debt_usd is unreliable
	// (different markets are written with different decimal conventions
	// so single positions can show $16B nonsense). Position counts ARE
	// reliable, so we expose count breakdowns for both protocols and a
	// dollar total ONLY for Aave. The dashboard renders the dollar line
	// labelled "Aave debt USD" and a stacked count for both protocols.
	const morphoRowsForHistogram = db.prepare(`
		SELECT ltv, lltv
		FROM morpho_borrower_snapshots
		WHERE ltv IS NOT NULL AND ltv > 0 AND ltv < 1e10
		  AND lltv IS NOT NULL AND lltv > 0
	`).all();
	const histogram = HF_BUCKETS.map(b => {
		const aave = db.prepare(`
			SELECT COUNT(*)                          AS count,
			       COALESCE(SUM(total_debt_usd), 0) AS debt_usd
			FROM borrower_snapshots
			WHERE health_factor > ?
			  AND health_factor <= ?
			  AND total_debt_usd IS NOT NULL
			  AND total_debt_usd > 0
		`).get(b.min, b.max);
		let morphoCount = 0;
		for (const r of morphoRowsForHistogram) {
			const hf = r.lltv / r.ltv;
			if (hf > b.min && hf <= b.max) morphoCount += 1;
		}
		return {
			bucket: b.label,
			min_hf: b.min,
			max_hf: b.max,
			aave_count: aave.count,
			aave_debt_usd: aave.debt_usd,
			morpho_count: morphoCount,
			total_count: aave.count + morphoCount
		};
	});

	// Top 10 at-risk (one-line preview for the dashboard). We dedup
	// addresses across protocols so a single dashboard row points to
	// "the worst" position for that borrower.
	const topAtRisk = listAtRiskBorrowers(db, {
		max_hf: 1.05,
		min_debt_usd: 1000,
		limit: 10,
		_sparkPath: params._sparkPath
	});

	// Liquidations-per-day for the last 30 days. `missed_liquidations`
	// is only ~2.4K rows so a date-aggregated query is cheap; the
	// timestamp index makes the range scan fast.
	const cutoff30d = now - 30 * 24 * 60 * 60 * 1000;
	const cutoff24h = now - windowMs;
	const liqsPerDay = db.prepare(`
		SELECT
			CAST((timestamp - (timestamp % 86400000)) AS INTEGER) AS day_ms,
			COUNT(*)                                              AS count,
			COALESCE(SUM(debt_usd), 0)                            AS debt_usd
		FROM missed_liquidations
		WHERE timestamp >= ?
		GROUP BY day_ms
		ORDER BY day_ms ASC
	`).all(cutoff30d);

	// 24h liquidation count, from the DB rather than the truncated
	// recent_liquidations list — so the KPI isn't capped at 10.
	const liqs24h = db.prepare(`
		SELECT COUNT(*) AS count, COALESCE(SUM(debt_usd), 0) AS debt_usd
		FROM missed_liquidations WHERE timestamp >= ?
	`).get(cutoff24h);

	// Seneschal's own activity over the last 24h. Counts only — we
	// deliberately do NOT expose total profit in USD or strategy
	// labels because those are operator-private. The intent is a
	// "is the bot doing its job?" signal that operators (and curious
	// outsiders) can see without revealing how much money is at stake.
	//
	// IMPORTANT — three layers of "honest counting":
	//
	// (a) Attempts = COUNT(DISTINCT tx_hash) over rows where tx_hash
	//     looks like a real on-chain hash (`0x` + 64 hex chars). The
	//     bot writes a row per outcome (submit, timeout, missed, failed)
	//     for each bundle, so a naive COUNT(*) double- or triple-counts
	//     every single attempt. Distinct tx_hash collapses these back
	//     to one row per pursued opportunity.
	//
	// (b) Skipped decisions ('aave_low_gas_skip', 'aave_preflight_*',
	//     'aave_gas_budget_rejected', 'aave_revalidation_skip') don't
	//     have a tx_hash at all and are excluded — those are "we looked
	//     and decided not to fire", not attempts.
	//
	// (c) Wins require BOTH success=1 AND a real tx_hash. A historical
	//     writer bug (since fixed) flipped success=1 on no-tx rows when
	//     the call-site packed positional args tightly and misaligned
	//     the success column with a string value. Even after the writer
	//     fix, we keep the tx_hash predicate as defence-in-depth.
	const REAL_TX = `tx_hash IS NOT NULL
		AND tx_hash LIKE '0x%'
		AND length(tx_hash) = 66`;
	const ourExec24h = db.prepare(`
		SELECT
			COUNT(DISTINCT tx_hash) AS attempts,
			COUNT(DISTINCT CASE WHEN success=1 THEN tx_hash END) AS successes
		FROM executions
		WHERE timestamp >= ?
		  AND ${REAL_TX}
	`).get(cutoff24h);
	const ourExec7d = db.prepare(`
		SELECT
			COUNT(DISTINCT tx_hash) AS attempts,
			COUNT(DISTINCT CASE WHEN success=1 THEN tx_hash END) AS successes
		FROM executions
		WHERE timestamp >= ?
		  AND ${REAL_TX}
	`).get(now - 7 * 24 * 60 * 60 * 1000);

	// At-risk count — anything with HF below 1.05. Aave straight from
	// snapshots; Morpho synthesised from ltv/lltv.
	const aaveAtRisk = db.prepare(`
		SELECT COUNT(*) AS count, COALESCE(SUM(total_debt_usd), 0) AS debt_usd
		FROM borrower_snapshots
		WHERE health_factor > 0 AND health_factor < 1.05
		  AND total_debt_usd > 0
	`).get();
	let morphoAtRiskCount = 0;
	for (const r of morphoRowsForHistogram) {
		const hf = r.lltv / r.ltv;
		if (hf > 0 && hf < 1.05) morphoAtRiskCount += 1;
	}

	// Builder leaderboard for multiple windows so the dashboard can
	// show trend without persisted history (24h vs 7d delta).
	const [share24h, share7d, share30d] = await Promise.all([
		getBuilderLeaderboard({ window: '24h', limit: 50, _shadowPath: shadowPath, _ttlMs: ttlMs }),
		getBuilderLeaderboard({ window: '7d',  limit: 50, _shadowPath: shadowPath, _ttlMs: ttlMs }),
		getBuilderLeaderboard({ window: '30d', limit: 50, _shadowPath: shadowPath, _ttlMs: ttlMs })
	]);

	// Find Seneschal's own row in each window so the operator activity
	// panel can show "our blocks landed". Matched on the builder label
	// produced by getBuilderLeaderboard (which normalises extra_data
	// and known coinbase addresses to a clean display string).
	const findSelf = (builders) =>
		builders.find(b => /^seneschal/i.test(b.builder)) ?? { builder: 'seneschal', slots_won: 0, captured_eth: 0 };
	const selfBuilder24h = findSelf(share24h.builders);
	const selfBuilder7d  = findSelf(share7d.builders);
	const selfBuilder30d = findSelf(share30d.builders);
	// Trim the public leaderboard slice back to top 8 for the donut.
	share24h.builders = share24h.builders.slice(0, 8);
	share7d.builders  = share7d.builders.slice(0, 8);
	share30d.builders = share30d.builders.slice(0, 8);

	// Recent on-chain liquidations (last 24h) — the dashboard renders
	// this as a feed.
	const recent24h = recentLiquidations(db, {
		since_ms: now - 24 * 60 * 60 * 1000,
		limit: 20
	});

	// File mtimes for the freshness panel. None of these reveal data
	// content; they're just "yes, the writer is alive" indicators.
	const freshness = {
		shadow_blocks_age_s: fileMtimeMs(shadowPath)
			? Math.round((now - fileMtimeMs(shadowPath)) / 1000) : null,
		spark_borrowers_age_s: fileMtimeMs(params._sparkPath)
			? Math.round((now - fileMtimeMs(params._sparkPath)) / 1000) : null,
		latest_borrower_snapshot_age_s: (() => {
			const r = db.prepare(`SELECT max(last_seen_ts) AS t FROM borrower_snapshots`).get();
			return r?.t ? Math.round((now - r.t) / 1000) : null;
		})(),
		latest_execution_age_s: (() => {
			const r = db.prepare(`SELECT max(timestamp) AS t FROM executions`).get();
			return r?.t ? Math.round((now - r.t) / 1000) : null;
		})(),
		latest_missed_liquidation_age_s: (() => {
			const r = db.prepare(`SELECT max(timestamp) AS t FROM missed_liquidations`).get();
			return r?.t ? Math.round((now - r.t) / 1000) : null;
		})()
	};

	return {
		as_of_ms: now,
		// Pre-aggregated KPI block. The dashboard reads these directly
		// instead of recomputing from the histogram / recent feed so the
		// hero tiles aren't capped by the slice limits.
		kpis: {
			positions_tracked: totals.borrower_snapshots + totals.morpho_borrower_snapshots,
			aave_debt_under_watch_usd: aaveAggregate.total_debt_usd,
			aave_collateral_under_watch_usd: aaveAggregate.total_collateral_usd,
			at_risk_count: aaveAtRisk.count + morphoAtRiskCount,
			at_risk_aave_count: aaveAtRisk.count,
			at_risk_aave_debt_usd: aaveAtRisk.debt_usd,
			at_risk_morpho_count: morphoAtRiskCount,
			liquidations_24h_count: liqs24h.count,
			liquidations_24h_debt_usd: liqs24h.debt_usd
		},
		// "Are we actually working?" panel. Counts only — never profit.
		// All numbers here are derivable from on-chain data anyway, so
		// publishing them gives no edge to competitors but reassures the
		// operator that the bot is doing its job.
		operator_activity: {
			liquidation_attempts_24h: ourExec24h.attempts,
			liquidations_won_24h:     ourExec24h.successes,
			win_rate_24h: ourExec24h.attempts > 0
				? ourExec24h.successes / ourExec24h.attempts : null,
			liquidation_attempts_7d:  ourExec7d.attempts,
			liquidations_won_7d:      ourExec7d.successes,
			builder_blocks_landed_24h: selfBuilder24h.slots_won ?? 0,
			builder_blocks_landed_7d:  selfBuilder7d.slots_won ?? 0,
			builder_blocks_landed_30d: selfBuilder30d.slots_won ?? 0,
			data_freshness: freshness
		},
		totals,
		aave_aggregate: aaveAggregate,
		hf_histogram: histogram,
		top_at_risk: topAtRisk.results.map(r => ({
			borrower: r.borrower,
			protocol: r.protocol,
			health_factor: r.health_factor,
			// Morpho debt_usd is unreliable (see notes in histogram code);
			// nullify it here so the dashboard doesn't render misleading
			// numbers. Aave debt stays as-is.
			debt_usd: r.protocol === 'morpho' ? null : r.debt_usd,
			liquidatable: r.liquidatable
		})),
		liquidations_30d_per_day: liqsPerDay,
		builders: {
			'24h': share24h.builders,
			'7d':  share7d.builders,
			'30d': share30d.builders,
			total_slots_24h: share24h.total_slots,
			total_slots_7d:  share7d.total_slots,
			total_slots_30d: share30d.total_slots
		},
		recent_liquidations: recent24h.results.slice(0, 10),
		// Optional "Support development" panel. Each chain only renders
		// when its env-driven address is non-empty, so the panel stays
		// invisible by default. No revenue here is captured automatically:
		// these are direct tip addresses, set via SENESCHAL_DONATE_ETH /
		// _BTC / _GITHUB on the data-api service.
		support: getSupportBlock(),
		// Optional "Premium tier" panel. Surfaces the x402 paywall
		// metadata (network, recipient, per-call price) so agents and
		// humans alike can see that paid endpoints exist. Whether the
		// dashboard renders this is decided by the frontend; the
		// backend simply exposes the data when X402_RECIPIENT_ADDRESS
		// is set.
		premium_tier: getPremiumTierBlock()
	};
}

// Built once-per-call rather than memoised because the config values
// are frozen at process start anyway, so the cost is negligible and
// it keeps tests deterministic when they inject overrides via env.
function getSupportBlock() {
	const eth = (config.donateEth || '').trim();
	const btc = (config.donateBtc || '').trim();
	const github = (config.donateGithub || '').trim();
	const message = config.donateMessage || '';
	const enabled = Boolean(eth || btc || github);
	return {
		enabled,
		message: enabled ? message : null,
		addresses: {
			ethereum: eth || null,
			bitcoin: btc || null
		},
		github_sponsors_url: github || null
	};
}

function getPremiumTierBlock() {
	const enabled = config.x402Enabled || Boolean((config.x402RecipientAddress || '').trim());
	if (!enabled) {
		return { enabled: false };
	}
	const recipient = (config.x402RecipientAddress || '').trim();
	return {
		enabled: true,
		protocol: 'x402',
		network: config.x402Network,
		payTo: recipient,
		price_per_call: config.x402FeedPrice,
		endpoint: 'https://api.seneschal.space/v1/premium/opportunities',
		mcp_tool: 'seneschal_premium_opportunities',
		docs: 'https://docs.x402.org',
		blurb: config.x402PaywallDescription
	};
}

// Re-export pieces tests want.
export const _internal = {
	normaliseAddress,
	clampLimit,
	validateProtocol,
	validateGranularity
};
