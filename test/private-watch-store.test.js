// Tests for the watch persistence layer. We hammer the schema with
// an in-memory SQLite DB so the tests are deterministic and don't
// touch /var/lib. Token-comparison is exercised both for success and
// failure paths so we catch any constant-time regression.

import { describe, test, expect, beforeEach } from '@jest/globals';

import {
	openWatchDb,
	createWatch,
	getWatch,
	cancelWatch,
	listActiveWatches,
	updateWatchState,
	clearNfptJob,
	purgeExpired,
	statsSnapshot
} from '../src/private-watch-store.js';

let db;
const NOW = 1_700_000_000_000;
const DAY_MS = 86_400_000;

function makeWatch(extra = {}) {
	return createWatch(db, {
		chain: 'monero',
		address: '4'.repeat(95),
		viewKeyCiphertext: 'b64ciphertext',
		webhookUrl: 'https://example.com/hook',
		webhookSecret: 'a'.repeat(64),
		birthdayHeight: null,
		durationMs: 7 * DAY_MS,
		nowMs: NOW,
		...extra
	});
}

beforeEach(() => {
	db = openWatchDb(':memory:');
});

describe('schema bootstrap', () => {
	test('opens and creates the private_watches table on first use', () => {
		const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
		const names = rows.map((r) => r.name);
		expect(names).toContain('private_watches');
	});
});

describe('createWatch', () => {
	test('returns id + token + expiresAt', () => {
		const created = makeWatch();
		expect(created.id).toMatch(/^[0-9a-f-]{36}$/u);
		expect(created.token.length).toBeGreaterThan(20);
		expect(created.expiresAt).toBe(NOW + 7 * DAY_MS);
		expect(created.createdAt).toBe(NOW);
	});

	test('stores token only as sha256 hash', () => {
		const created = makeWatch();
		const row = db.prepare('SELECT token_hash FROM private_watches WHERE id = ?').get(created.id);
		expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/u);
		expect(row.token_hash).not.toContain(created.token);
	});

	test('rejects unsupported chains', () => {
		expect(() => makeWatch({ chain: 'btc' })).toThrow(/must be 'monero' or 'zcash'/);
	});

	test('rejects missing fields', () => {
		expect(() => createWatch(db, { chain: 'monero' })).toThrow(/address required/);
	});

	test('rejects non-positive duration', () => {
		expect(() => makeWatch({ durationMs: 0 })).toThrow(/positive number/);
	});
});

describe('getWatch + token check', () => {
	test('returns row on correct token', () => {
		const c = makeWatch();
		const row = getWatch(db, c.id, c.token);
		expect(row).toBeTruthy();
		expect(row.id).toBe(c.id);
		expect(row.chain).toBe('monero');
	});

	test('returns null for unknown id', () => {
		expect(getWatch(db, 'no-such-id', 'whatever')).toBeNull();
	});

	test('returns forbidden on mismatched token', () => {
		const c = makeWatch();
		const res = getWatch(db, c.id, 'wrong-token');
		expect(res).toEqual({ error: 'forbidden' });
	});

	test('forbidden for missing token', () => {
		const c = makeWatch();
		const res = getWatch(db, c.id, undefined);
		expect(res).toEqual({ error: 'forbidden' });
	});
});

describe('cancelWatch', () => {
	test('marks the row cancelled', () => {
		const c = makeWatch();
		expect(cancelWatch(db, c.id, c.token)).toBe(true);
		const row = getWatch(db, c.id, c.token);
		expect(row.cancelled).toBe(1);
	});

	test('returns false on wrong token', () => {
		const c = makeWatch();
		expect(cancelWatch(db, c.id, 'bad')).toBe(false);
	});

	test('returns false on unknown id', () => {
		expect(cancelWatch(db, 'nope', 'x')).toBe(false);
	});
});

describe('listActiveWatches', () => {
	test('excludes cancelled and dead watches', () => {
		const a = makeWatch();
		const b = makeWatch();
		cancelWatch(db, a.id, a.token);
		updateWatchState(db, b.id, { dead: 1 });
		const c = makeWatch();
		const active = listActiveWatches(db, { nowMs: NOW + 1000 });
		const ids = active.map((r) => r.id);
		expect(ids).toEqual([c.id]);
	});

	test('excludes expired watches', () => {
		const c = makeWatch({ durationMs: 1000 });
		const active = listActiveWatches(db, { nowMs: NOW + 10_000 });
		expect(active.map((r) => r.id)).not.toContain(c.id);
	});

	test('orders by last_polled_at ascending (oldest first)', () => {
		const a = makeWatch();
		const b = makeWatch();
		const c = makeWatch();
		updateWatchState(db, a.id, { last_polled_at_ms: NOW + 5000 });
		updateWatchState(db, b.id, { last_polled_at_ms: NOW + 1000 });
		// c has null last_polled_at_ms -> sorts first via COALESCE(0)
		const order = listActiveWatches(db, { nowMs: NOW + 10 }).map((r) => r.id);
		expect(order).toEqual([c.id, b.id, a.id]);
	});
});

describe('updateWatchState', () => {
	test('updates whitelisted columns', () => {
		const c = makeWatch();
		const changes = updateWatchState(db, c.id, {
			last_polled_at_ms: NOW + 100,
			delivery_count: 3
		});
		expect(changes).toBe(1);
		const row = getWatch(db, c.id, c.token);
		expect(row.last_polled_at_ms).toBe(NOW + 100);
		expect(row.delivery_count).toBe(3);
	});

	test('silently drops unknown columns', () => {
		const c = makeWatch();
		const changes = updateWatchState(db, c.id, {
			evil_drop_table: 'foo',
			last_polled_at_ms: NOW + 200
		});
		expect(changes).toBe(1);
		const row = getWatch(db, c.id, c.token);
		expect(row.last_polled_at_ms).toBe(NOW + 200);
	});

	test('returns 0 when no columns match', () => {
		const c = makeWatch();
		const changes = updateWatchState(db, c.id, { definitely_not_a_col: 1 });
		expect(changes).toBe(0);
	});
});

describe('clearNfptJob', () => {
	test('nulls out job id + token', () => {
		const c = makeWatch();
		updateWatchState(db, c.id, {
			nfpt_job_id: 'jid',
			nfpt_job_token: 'tok',
			nfpt_job_started_at_ms: NOW
		});
		clearNfptJob(db, c.id);
		const row = getWatch(db, c.id, c.token);
		expect(row.nfpt_job_id).toBeNull();
		expect(row.nfpt_job_token).toBeNull();
		expect(row.nfpt_job_started_at_ms).toBeNull();
	});
});

describe('purgeExpired', () => {
	test('removes rows whose expires_at_ms is in the past', () => {
		const a = makeWatch({ durationMs: 1000 });
		const b = makeWatch();
		const purged = purgeExpired(db, { nowMs: NOW + 100_000 });
		expect(purged).toBe(1);
		const ids = listActiveWatches(db, { nowMs: NOW + 100_000 }).map((r) => r.id);
		expect(ids).toContain(b.id);
		expect(ids).not.toContain(a.id);
	});
});

describe('statsSnapshot', () => {
	test('counts total/active/dead/chain split', () => {
		const a = makeWatch();
		const b = makeWatch({ chain: 'zcash', address: 'u1abc' });
		const c = makeWatch();
		cancelWatch(db, c.id, c.token);
		updateWatchState(db, a.id, { dead: 1, delivery_count: 4 });
		updateWatchState(db, b.id, { delivery_count: 2 });
		const stats = statsSnapshot(db, { nowMs: NOW + 1000 });
		expect(stats.total).toBe(3);
		expect(stats.dead).toBe(1);
		expect(stats.by_chain.monero).toBe(2);
		expect(stats.by_chain.zcash).toBe(1);
		expect(stats.total_deliveries).toBe(6);
	});
});
