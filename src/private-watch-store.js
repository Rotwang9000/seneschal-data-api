// SQLite persistence for the private-watch service.
//
// Unlike `db.js` (which is a read-only handle to the bot's mev-logs
// DB) this is the only writer in the project. The schema is small —
// one table — and we own both the writer (rest-server + poller) and
// the reader so there's no migration etiquette to worry about; the
// DDL self-creates on first open.
//
// Rows store:
//   - the encrypted view key (NEVER plaintext on disk)
//   - the per-watch webhook signing secret (plaintext: the receiver
//     already has it; protecting it from a host-compromised attacker
//     buys nothing)
//   - the watch token hash (constant-time check on poll/delete)
//   - balance state snapshots (last reported vs last observed)
//   - bookkeeping for the poller (next attempt, attempt count, dead-letter flag)
//
// The store is intentionally framework-agnostic — `rest-server.js`
// and `scripts/private-watch-poller.mjs` both consume the same
// exports. That keeps the surface easy to test with a `:memory:` DB.

import Database from 'better-sqlite3';
import { createHash, randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const WATCH_DDL = `
CREATE TABLE IF NOT EXISTS private_watches (
	id TEXT PRIMARY KEY,
	token_hash TEXT NOT NULL,
	chain TEXT NOT NULL CHECK(chain IN ('monero','zcash')),
	address TEXT NOT NULL,
	view_key_ct TEXT NOT NULL,
	webhook_url TEXT NOT NULL,
	webhook_secret TEXT NOT NULL,
	birthday_height INTEGER,
	expires_at_ms INTEGER NOT NULL,
	created_at_ms INTEGER NOT NULL,

	-- upstream NFPT job linkage (re-established lazily on poll if NULL/stale)
	nfpt_job_id TEXT,
	nfpt_job_token TEXT,
	nfpt_job_started_at_ms INTEGER,

	-- balance state (JSON)
	last_known_balance TEXT,    -- most recent snapshot from NFPT
	last_delivered_balance TEXT, -- snapshot at last successful webhook
	last_polled_at_ms INTEGER,
	last_delivered_at_ms INTEGER,

	-- delivery bookkeeping
	delivery_attempts INTEGER DEFAULT 0,
	delivery_count INTEGER DEFAULT 0,
	last_delivery_error TEXT,
	last_delivered_event TEXT,
	dead INTEGER DEFAULT 0,
	cancelled INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_watch_active
	ON private_watches(cancelled, dead, expires_at_ms);
CREATE INDEX IF NOT EXISTS idx_watch_poll
	ON private_watches(last_polled_at_ms);
`;

/**
 * Open (or create) the watch DB. Pass a `:memory:` path in tests.
 * The parent directory is created if absent so deployments don't
 * have to pre-mkdir the state dir.
 *
 * Idempotent schema migration: `last_delivered_event` was added in a
 * later revision. We ALTER TABLE … ADD COLUMN if the table already
 * exists without it, ignoring "duplicate column" errors so re-opens
 * are a no-op.
 */
export function openWatchDb(path) {
	if (typeof path !== 'string' || path.length === 0) {
		throw new TypeError('openWatchDb: path must be a non-empty string');
	}
	if (path !== ':memory:') {
		try { mkdirSync(dirname(path), { recursive: true }); }
		catch { /* ignore: better-sqlite3 will surface a clearer error */ }
	}
	const db = new Database(path);
	db.pragma('journal_mode = WAL');
	db.pragma('synchronous = NORMAL');
	db.pragma('foreign_keys = ON');
	db.exec(WATCH_DDL);
	addColumnIfMissing(db, 'private_watches', 'last_delivered_event', 'TEXT');
	return db;
}

function addColumnIfMissing(db, table, col, type) {
	try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).run(); }
	catch (err) {
		if (!/duplicate column/i.test(err?.message ?? '')) throw err;
	}
}

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Generate a watch ID + watch token pair. The token is returned to
 * the caller (only) and a sha256 of it is stored. Polls/cancellations
 * present the token and we constant-time compare hashes.
 */
function newIdAndToken() {
	return {
		id: randomUUID(),
		token: randomBytes(32).toString('base64url')
	};
}

function constantEqHex(a, b) {
	if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
	const bufA = Buffer.from(a, 'hex');
	const bufB = Buffer.from(b, 'hex');
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

/**
 * Create a new watch row. Pure-input contract — the caller has
 * already done validation (chain, address shape, encrypted view key,
 * webhook URL safety, etc.) and just hands us the resolved values.
 */
export function createWatch(db, params) {
	const {
		chain,
		address,
		viewKeyCiphertext,
		webhookUrl,
		webhookSecret,
		birthdayHeight = null,
		durationMs,
		nowMs = Date.now()
	} = params;
	if (!['monero', 'zcash'].includes(chain)) {
		throw new TypeError(`createWatch: chain=${chain} must be 'monero' or 'zcash'`);
	}
	if (typeof address !== 'string' || address.length === 0) {
		throw new TypeError('createWatch: address required');
	}
	if (typeof viewKeyCiphertext !== 'string' || viewKeyCiphertext.length === 0) {
		throw new TypeError('createWatch: viewKeyCiphertext required');
	}
	if (typeof webhookUrl !== 'string' || webhookUrl.length === 0) {
		throw new TypeError('createWatch: webhookUrl required');
	}
	if (typeof webhookSecret !== 'string' || webhookSecret.length === 0) {
		throw new TypeError('createWatch: webhookSecret required');
	}
	if (!Number.isFinite(durationMs) || durationMs <= 0) {
		throw new TypeError('createWatch: durationMs must be a positive number');
	}
	const { id, token } = newIdAndToken();
	const tokenHash = sha256(Buffer.from(token, 'utf8'));
	const expiresAt = nowMs + durationMs;
	db.prepare(`
		INSERT INTO private_watches (
			id, token_hash, chain, address, view_key_ct,
			webhook_url, webhook_secret, birthday_height,
			expires_at_ms, created_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		id,
		tokenHash,
		chain,
		address,
		viewKeyCiphertext,
		webhookUrl,
		webhookSecret,
		birthdayHeight,
		expiresAt,
		nowMs
	);
	return { id, token, expiresAt, createdAt: nowMs };
}

/**
 * Fetch a row by ID *and* verify the caller has the matching token.
 * Returns:
 *   - `null` if no row exists
 *   - `{ error: 'forbidden' }` if the token doesn't match
 *   - the row object otherwise
 *
 * Token comparison is constant-time via timingSafeEqual over the
 * sha256 buffers.
 */
export function getWatch(db, id, token) {
	const row = db.prepare('SELECT * FROM private_watches WHERE id = ?').get(id);
	if (!row) return null;
	const presented = sha256(Buffer.from(String(token ?? ''), 'utf8'));
	if (!constantEqHex(presented, row.token_hash)) return { error: 'forbidden' };
	return row;
}

/**
 * Cancel a watch (mark cancelled = 1). Returns true on success,
 * false if not found / wrong token. The row remains for record
 * retention but the poller filters it out via the cancelled
 * predicate.
 */
export function cancelWatch(db, id, token) {
	const got = getWatch(db, id, token);
	if (!got || got.error) return false;
	db.prepare('UPDATE private_watches SET cancelled = 1 WHERE id = ?').run(id);
	return true;
}

/**
 * Return all watches that are not cancelled, not dead, and not yet
 * expired. The poller drives off this list. Optional `staleAfterMs`
 * cap so the poller can re-check every watch every N seconds
 * regardless of when it last polled.
 */
export function listActiveWatches(db, { nowMs = Date.now() } = {}) {
	return db.prepare(`
		SELECT *
		FROM private_watches
		WHERE cancelled = 0
		  AND dead = 0
		  AND expires_at_ms > ?
		ORDER BY COALESCE(last_polled_at_ms, 0) ASC
	`).all(nowMs);
}

/**
 * Patch a watch's poller state. Only the keys present in `patch` are
 * touched; unknown keys are silently rejected so a typo can't widen
 * the field list by mistake. Uses a hardcoded ALLOWED list as the
 * schema check.
 */
export function updateWatchState(db, id, patch) {
	const ALLOWED = new Set([
		'nfpt_job_id',
		'nfpt_job_token',
		'nfpt_job_started_at_ms',
		'last_known_balance',
		'last_delivered_balance',
		'last_polled_at_ms',
		'last_delivered_at_ms',
		'last_delivered_event',
		'delivery_attempts',
		'delivery_count',
		'last_delivery_error',
		'dead'
	]);
	const cols = [];
	const vals = [];
	for (const [k, v] of Object.entries(patch || {})) {
		if (!ALLOWED.has(k)) continue;
		cols.push(`${k} = ?`);
		vals.push(v);
	}
	if (cols.length === 0) return 0;
	vals.push(id);
	const sql = `UPDATE private_watches SET ${cols.join(', ')} WHERE id = ?`;
	const info = db.prepare(sql).run(...vals);
	return info.changes;
}

/**
 * Reset the NFPT job linkage. Used when the upstream job has aged out
 * and the poller needs to start a fresh one on the next tick.
 */
export function clearNfptJob(db, id) {
	db.prepare(`
		UPDATE private_watches
		SET nfpt_job_id = NULL,
		    nfpt_job_token = NULL,
		    nfpt_job_started_at_ms = NULL
		WHERE id = ?
	`).run(id);
}

/**
 * Hard-delete any watch row whose expires_at_ms is in the past.
 * Returns the number of rows pruned. Run from the poller at end of
 * each cycle to keep the table tiny.
 */
export function purgeExpired(db, { nowMs = Date.now() } = {}) {
	const info = db.prepare('DELETE FROM private_watches WHERE expires_at_ms <= ?').run(nowMs);
	return info.changes;
}

/**
 * Quick stats for the public health endpoint. We deliberately do NOT
 * include any of the user-supplied data here — just counters — so the
 * health check is safe to expose without auth.
 */
export function statsSnapshot(db, { nowMs = Date.now() } = {}) {
	const counters = db.prepare(`
		SELECT
			COUNT(*) AS total,
			SUM(CASE WHEN cancelled = 0 AND dead = 0 AND expires_at_ms > ? THEN 1 ELSE 0 END) AS active,
			SUM(CASE WHEN dead = 1 THEN 1 ELSE 0 END) AS dead,
			SUM(CASE WHEN expires_at_ms <= ? THEN 1 ELSE 0 END) AS expired,
			SUM(CASE WHEN chain = 'monero' THEN 1 ELSE 0 END) AS monero,
			SUM(CASE WHEN chain = 'zcash' THEN 1 ELSE 0 END) AS zcash,
			SUM(delivery_count) AS total_deliveries
		FROM private_watches
	`).get(nowMs, nowMs);
	return {
		total: counters.total ?? 0,
		active: counters.active ?? 0,
		dead: counters.dead ?? 0,
		expired: counters.expired ?? 0,
		by_chain: {
			monero: counters.monero ?? 0,
			zcash: counters.zcash ?? 0
		},
		total_deliveries: counters.total_deliveries ?? 0
	};
}

export const WATCH_SCHEMA = Object.freeze({ WATCH_DDL });
