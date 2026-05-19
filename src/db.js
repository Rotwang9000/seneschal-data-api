// Thin wrapper around better-sqlite3 providing:
// - read-only connections to the live mev-logs DB (we never write)
// - sensible pragmas (busy timeout, query_only, mmap for big db reads)
// - lazy-readable JSON snapshot files (morpho/spark borrower lists)
// - a process-cached file reader so repeat tool calls don't re-stat
//
// Why better-sqlite3: the live DB is on the same host (no network), we want
// synchronous semantics for short queries, and it scales well to a 150-GB
// file via mmap. The official driver is the project's existing dependency
// so there's no version skew vs the bot writer.

import Database from 'better-sqlite3';
import { existsSync, statSync, readFileSync } from 'node:fs';
import config from './config.js';

let _liveDb = null;

// `db` is the read-only handle to the running mev-logs SQLite. We only
// open it once per process to keep file-descriptor count low; reads from
// many concurrent endpoints are safe under SQLite's WAL mode.
export function openLiveDb(path = config.mevLogsDbPath) {
	if (_liveDb && _liveDb.open) return _liveDb;
	if (!existsSync(path)) {
		throw new Error(`db: source file ${path} does not exist`);
	}
	const db = new Database(path, { readonly: true, fileMustExist: true });
	// Defensive: even with readonly:true, set query_only as belt + braces.
	db.pragma('query_only = ON');
	db.pragma(`busy_timeout = ${config.sqliteBusyTimeoutMs}`);
	// 256 MB mmap window — big db, but we never scan more than a few
	// thousand rows per request thanks to LIMIT clauses everywhere.
	db.pragma('mmap_size = 268435456');
	_liveDb = db;
	return db;
}

// Some tests need a fresh in-memory DB seeded with rows matching the live
// schema. Public so test fixtures can hand the resulting db to functions
// in queries.js.
export function openTestDb() {
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	db.exec(BORROWER_SNAPSHOTS_DDL);
	db.exec(AAVE_HISTORY_DDL);
	db.exec(MORPHO_SNAPSHOTS_DDL);
	db.exec(MORPHO_HISTORY_DDL);
	db.exec(MISSED_LIQUIDATIONS_DDL);
	db.exec(EXECUTIONS_DDL);
	db.exec(MORPHO_ATTEMPTS_DDL);
	return db;
}

// File-cached JSON reader. Stat-based invalidation: we only re-read when
// the file's mtime changes. This matters for the morpho/spark JSON
// snapshots which the writer rewrites in place ~every 10 minutes; without
// caching, every request would re-parse a multi-MB JSON blob.
const _jsonCache = new Map();

export function readJsonCached(path) {
	if (!existsSync(path)) return null;
	const st = statSync(path);
	const cached = _jsonCache.get(path);
	if (cached && cached.mtimeMs === st.mtimeMs) return cached.data;
	const raw = readFileSync(path, 'utf8');
	const data = JSON.parse(raw);
	_jsonCache.set(path, { mtimeMs: st.mtimeMs, data });
	return data;
}

export function fileMtimeMs(path) {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return null;
	}
}

// Schema DDL — exact copy of what mev-logs-1.db's writer creates, kept here
// so the in-memory test DB matches. If the writer ever changes a column the
// integration tests will go red and we know to update both. Keeping them
// inline (vs reading from the live file) means the tests don't need a
// pre-populated DB on disk.
// Schemas are kept verbatim against the live writer's tables on fin4
// (verified 2026-05-14 via `PRAGMA table_info(...)`). Mismatches between
// these DDLs and reality will surface as SQL "no such column" errors in
// queries.js, so any writer-side schema change MUST be mirrored here.

const BORROWER_SNAPSHOTS_DDL = `
CREATE TABLE borrower_snapshots (
	borrower_address TEXT PRIMARY KEY,
	last_seen_ts INTEGER NOT NULL,
	block_number INTEGER NOT NULL,
	health_factor REAL,
	total_collateral_usd REAL,
	total_debt_usd REAL,
	liquidatable INTEGER DEFAULT 0,
	error TEXT,
	collateral_asset TEXT,
	debt_asset TEXT,
	unique_collateral_count INTEGER,
	unique_debt_count INTEGER,
	is_single_asset INTEGER DEFAULT 0,
	asset_updated_at INTEGER,
	collateral_price_usd REAL,
	debt_price_usd REAL,
	scan_interval_ms INTEGER,
	next_scan_ts INTEGER
);
CREATE INDEX idx_snapshot_last_seen ON borrower_snapshots(last_seen_ts DESC);
CREATE INDEX idx_snapshot_debt ON borrower_snapshots(total_debt_usd DESC);
`;

const AAVE_HISTORY_DDL = `
CREATE TABLE aave_borrower_history (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	timestamp INTEGER NOT NULL,
	block_number INTEGER NOT NULL,
	borrower_address TEXT NOT NULL,
	health_factor REAL,
	total_collateral_usd REAL,
	total_debt_usd REAL,
	liquidatable INTEGER DEFAULT 0,
	ltv REAL,
	liquidation_threshold REAL,
	error TEXT
);
CREATE INDEX idx_aave_hist_ts ON aave_borrower_history(timestamp DESC);
CREATE INDEX idx_aave_hist_borrower ON aave_borrower_history(borrower_address, timestamp DESC);
`;

// Morpho snapshots have a composite PRIMARY KEY (market_id,
// borrower_address) — one borrower can have parallel positions across
// many markets. We surface each (market_id, borrower_address) row as a
// separate result so consumers see the actual at-risk position.
// There is no `health_factor` column: it's derived in queries.js as
// `lltv / ltv` (HF > 1 ↔ position is healthy; ratio → 1 ↔ liquidation).
const MORPHO_SNAPSHOTS_DDL = `
CREATE TABLE morpho_borrower_snapshots (
	market_id TEXT NOT NULL,
	borrower_address TEXT NOT NULL,
	last_seen_ts INTEGER NOT NULL,
	block_number INTEGER NOT NULL,
	ltv REAL,
	lltv REAL,
	debt_usd REAL,
	distance_to_liquidation REAL,
	error TEXT,
	PRIMARY KEY (market_id, borrower_address)
);
CREATE INDEX idx_morpho_snap_ts ON morpho_borrower_snapshots(last_seen_ts DESC);
CREATE INDEX idx_morpho_snap_debt ON morpho_borrower_snapshots(debt_usd DESC);
`;

const MORPHO_HISTORY_DDL = `
CREATE TABLE morpho_borrower_history (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	timestamp INTEGER NOT NULL,
	block_number INTEGER NOT NULL,
	market_id TEXT NOT NULL,
	borrower_address TEXT NOT NULL,
	ltv REAL,
	lltv REAL,
	debt_usd REAL,
	distance_to_liquidation REAL,
	error TEXT
);
CREATE INDEX idx_morpho_hist_ts ON morpho_borrower_history(timestamp DESC);
CREATE INDEX idx_morpho_hist_borrower ON morpho_borrower_history(borrower_address, timestamp DESC);
`;

const MISSED_LIQUIDATIONS_DDL = `
CREATE TABLE missed_liquidations (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	timestamp INTEGER NOT NULL,
	block_number INTEGER NOT NULL,
	tx_hash TEXT NOT NULL,
	borrower_address TEXT NOT NULL,
	collateral_asset TEXT,
	debt_asset TEXT,
	debt_to_cover TEXT,
	liquidated_collateral TEXT,
	liquidator TEXT,
	was_tracking INTEGER DEFAULT 0,
	would_have_been_profitable INTEGER DEFAULT 0,
	debt_usd REAL
);
CREATE INDEX idx_missed_timestamp ON missed_liquidations(timestamp DESC);
CREATE INDEX idx_missed_borrower ON missed_liquidations(borrower_address);
`;

const EXECUTIONS_DDL = `
CREATE TABLE executions (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	timestamp INTEGER NOT NULL,
	block_number INTEGER NOT NULL,
	opportunity_id INTEGER,
	strategy TEXT NOT NULL,
	borrower_address TEXT,
	tx_hash TEXT,
	success INTEGER DEFAULT 0,
	error TEXT,
	actual_profit_usd REAL,
	gas_used_usd REAL
);
CREATE INDEX idx_strategy ON executions(strategy);
CREATE INDEX idx_success ON executions(success);
CREATE INDEX idx_tx ON executions(tx_hash);
`;

// Mirror of mev-logs-1.db's morpho_attempts table. The premium feed
// joins per-market outcomes from here so an agent can see "we've
// already tried this market 14 times today and 0 landed".
const MORPHO_ATTEMPTS_DDL = `
CREATE TABLE morpho_attempts (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	timestamp INTEGER NOT NULL,
	block_number INTEGER,
	market_id TEXT,
	borrower_address TEXT,
	ltv REAL,
	lltv REAL,
	debt_usd REAL,
	estimated_profit_usd REAL,
	preflight INTEGER DEFAULT 0,
	outcome TEXT NOT NULL,
	stage TEXT,
	reason TEXT,
	tx_hash TEXT,
	gas_used INTEGER
);
CREATE INDEX idx_morpho_attempt_ts ON morpho_attempts(timestamp DESC);
CREATE INDEX idx_morpho_attempt_market ON morpho_attempts(market_id);
`;

// Exported for explicit test setup; useful when a test needs to verify
// the DDL matches the live schema (we do this in queries.test.js).
export const TEST_SCHEMA = {
	BORROWER_SNAPSHOTS_DDL,
	AAVE_HISTORY_DDL,
	MORPHO_SNAPSHOTS_DDL,
	MORPHO_HISTORY_DDL,
	MISSED_LIQUIDATIONS_DDL,
	EXECUTIONS_DDL,
	MORPHO_ATTEMPTS_DDL
};
