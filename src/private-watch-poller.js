// Private-watch poller: one tick walks every active watch, pulls the
// latest balance from NFPT, and ships a signed webhook on change.
//
// The module exports `runPollerTick(deps)` so a systemd timer or a
// long-running loop can drive it. Everything dependency-injectable
// (DB handle, NFPT client, fetch impl, master key) lives in `deps`
// so the unit tests can wire a `:memory:` DB plus stubs in ~10 LoC.
//
// State machine per watch (rough sketch):
//
//   - First tick: NFPT job missing -> start one, store {jobId, jobToken}
//   - Subsequent: GET the existing job, normalise the balance
//   - If NFPT returns 404 -> job aged out (1 h TTL upstream), clear + restart next tick
//   - If balance differs from `last_delivered_balance` -> sign + POST webhook
//     - Success: update `last_delivered_balance`, reset attempts
//     - Failure: bump attempts, leave for next cycle (next webhook delivery
//       happens 1 poll interval later — built-in 3-min backoff)
//     - After MAX_DELIVERY_ATTEMPTS consecutive failures: mark dead
//   - Always update last_polled_at_ms + last_known_balance
//
// Side-effecty bits (HTTP + DB writes) are kept in the dispatch
// functions; the diff/sign/payload helpers in private-watch.js stay
// pure and easily testable.

import {
	decryptViewKey,
	signWebhookBody
} from './private-watch-crypto.js';
import {
	startMoneroJob,
	pollMoneroJob,
	startOrchardJob,
	pollOrchardJob
} from './private-watch-nfpt.js';
import {
	listActiveWatches,
	updateWatchState,
	clearNfptJob,
	purgeExpired
} from './private-watch-store.js';
import {
	diffBalance,
	buildWebhookBody,
	WATCH_CONSTANTS
} from './private-watch.js';

const DEFAULT_WEBHOOK_TIMEOUT_MS = 8_000;
const MAX_LOG_REASON_LEN = 200;

/**
 * Run a single poller tick. Returns a summary object so the CLI
 * driver / tests can assert on what happened.
 *
 * Required deps:
 *   - db: better-sqlite3 handle to the watch DB
 *   - masterKey: Buffer(32) for decrypting view keys
 *   - nfptClient: from createNfptClient()
 * Optional deps:
 *   - fetchImpl: defaults to globalThis.fetch (used for webhook POST)
 *   - webhookTimeoutMs
 *   - logger: { info, warn, error } (default console)
 *   - now: () => ms (defaults Date.now)
 */
export async function runPollerTick(deps) {
	const {
		db,
		masterKey,
		nfptClient,
		fetchImpl = globalThis.fetch,
		webhookTimeoutMs = DEFAULT_WEBHOOK_TIMEOUT_MS,
		logger = console,
		now = () => Date.now()
	} = deps;
	if (!db) throw new TypeError('runPollerTick: db is required');
	if (!Buffer.isBuffer(masterKey)) throw new TypeError('runPollerTick: masterKey must be a Buffer');
	if (!nfptClient) throw new TypeError('runPollerTick: nfptClient is required');
	if (typeof fetchImpl !== 'function') throw new TypeError('runPollerTick: fetchImpl must be a function');

	const startMs = now();
	const summary = {
		started_at_ms: startMs,
		watches_seen: 0,
		watches_polled: 0,
		watches_dead: 0,
		jobs_started: 0,
		webhooks_attempted: 0,
		webhooks_delivered: 0,
		webhooks_failed: 0,
		watches_skipped: 0,
		errors: []
	};
	const active = listActiveWatches(db, { nowMs: startMs });
	summary.watches_seen = active.length;
	for (const row of active) {
		try {
			await pollOne({
				row, db, masterKey, nfptClient,
				fetchImpl, webhookTimeoutMs, logger, now, summary
			});
		}
		catch (err) {
			summary.errors.push({
				watchId: row.id,
				message: truncate(err?.message ?? String(err))
			});
			logger.warn?.({
				watchId: row.id,
				err: err?.message ?? String(err)
			}, 'private-watch: tick error');
		}
	}
	summary.expired_purged = purgeExpired(db, { nowMs: startMs });
	summary.elapsed_ms = now() - startMs;
	return summary;
}

async function pollOne({ row, db, masterKey, nfptClient, fetchImpl, webhookTimeoutMs, logger, now, summary }) {
	const viewKey = decryptViewKey(row.view_key_ct, masterKey);
	let jobId = row.nfpt_job_id;
	let jobToken = row.nfpt_job_token;
	let snapshot = null;
	let needsNewJob = !jobId || !jobToken;

	// Try the existing job first (cheap GET). If NFPT lost it (404
	// because the API restarted, or 5 min idle window), fall through
	// to start a fresh one.
	if (!needsNewJob) {
		const polled = row.chain === 'monero'
			? await pollMoneroJob(nfptClient, { jobId, jobToken })
			: await pollOrchardJob(nfptClient, { jobId, jobToken });
		if (!polled.found) {
			clearNfptJob(db, row.id);
			needsNewJob = true;
		}
		else {
			snapshot = polled.snapshot;
		}
	}

	if (needsNewJob) {
		const started = await startJobForRow({ row, viewKey, nfptClient });
		jobId = started.jobId;
		jobToken = started.jobToken;
		summary.jobs_started += 1;
		updateWatchState(db, row.id, {
			nfpt_job_id: jobId,
			nfpt_job_token: jobToken,
			nfpt_job_started_at_ms: now()
		});
		// Immediate poll so first balance shows up without waiting a
		// full tick interval.
		const polled = row.chain === 'monero'
			? await pollMoneroJob(nfptClient, { jobId, jobToken })
			: await pollOrchardJob(nfptClient, { jobId, jobToken });
		snapshot = polled.snapshot ?? null;
	}

	summary.watches_polled += 1;
	const beforeJson = row.last_delivered_balance;
	const before = beforeJson ? safeJson(beforeJson) : null;
	const diff = diffBalance(before, snapshot);
	const nowMs = now();
	const knownJson = snapshot ? JSON.stringify(snapshot) : null;
	updateWatchState(db, row.id, {
		last_polled_at_ms: nowMs,
		last_known_balance: knownJson
	});
	if (!diff) return;

	summary.webhooks_attempted += 1;
	const body = buildWebhookBody({
		watchId: row.id,
		chain: row.chain,
		address: row.address,
		before,
		after: snapshot,
		diff,
		nowMs
	});
	const result = await deliverWebhook({
		url: row.webhook_url,
		body,
		secret: row.webhook_secret,
		watchId: row.id,
		fetchImpl,
		timeoutMs: webhookTimeoutMs
	});
	if (result.ok) {
		summary.webhooks_delivered += 1;
		updateWatchState(db, row.id, {
			last_delivered_balance: knownJson,
			last_delivered_at_ms: nowMs,
			delivery_attempts: 0,
			delivery_count: (row.delivery_count ?? 0) + 1,
			last_delivery_error: null
		});
		logger.info?.({
			watchId: row.id,
			chain: row.chain,
			status: result.status,
			delta: diff.delta_atomic
		}, 'private-watch: webhook delivered');
	}
	else {
		summary.webhooks_failed += 1;
		const attempts = (row.delivery_attempts ?? 0) + 1;
		const dead = attempts >= WATCH_CONSTANTS.MAX_DELIVERY_ATTEMPTS;
		updateWatchState(db, row.id, {
			delivery_attempts: attempts,
			last_delivery_error: truncate(result.error ?? `HTTP ${result.status}`),
			dead: dead ? 1 : 0
		});
		if (dead) summary.watches_dead += 1;
		logger.warn?.({
			watchId: row.id,
			chain: row.chain,
			status: result.status,
			attempts,
			err: result.error
		}, dead ? 'private-watch: webhook dead-letter' : 'private-watch: webhook failed');
	}
}

async function startJobForRow({ row, viewKey, nfptClient }) {
	if (row.chain === 'monero') {
		return startMoneroJob(nfptClient, {
			address: row.address,
			viewKey,
			fromHeight: row.birthday_height ?? undefined
		});
	}
	return startOrchardJob(nfptClient, {
		ufvk: viewKey,
		birthdayHeight: row.birthday_height ?? undefined,
		autoDetect: row.birthday_height ? false : true
	});
}

/**
 * Deliver a signed webhook with the given body. Returns
 * `{ ok, status, error }`. Pure HTTP — no DB writes — so the caller
 * has full control over retry / state bookkeeping.
 *
 * Exported so unit tests can call it directly with a stub fetch.
 */
export async function deliverWebhook({
	url, body, secret, watchId,
	fetchImpl = globalThis.fetch,
	timeoutMs = DEFAULT_WEBHOOK_TIMEOUT_MS
}) {
	if (typeof url !== 'string') throw new TypeError('deliverWebhook: url is required');
	if (typeof body !== 'string') throw new TypeError('deliverWebhook: body must be a string');
	if (typeof secret !== 'string') throw new TypeError('deliverWebhook: secret is required');
	const signature = signWebhookBody(body, secret);
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(new Error('webhook: timed out')), timeoutMs);
	try {
		const res = await fetchImpl(url, {
			method: 'POST',
			signal: ac.signal,
			headers: {
				'content-type': 'application/json',
				'user-agent': 'Seneschal-PrivateWatch/1.0 (+https://seneschal.space)',
				'x-seneschal-signature': `sha256=${signature}`,
				'x-seneschal-watch-id': watchId ?? '',
				'x-seneschal-event': safeEventFromBody(body)
			},
			body
		});
		const ok = res.status >= 200 && res.status < 300;
		return { ok, status: res.status, error: ok ? null : `non-2xx HTTP ${res.status}` };
	}
	catch (err) {
		return {
			ok: false,
			status: 0,
			error: truncate(err?.message ?? String(err))
		};
	}
	finally {
		clearTimeout(t);
	}
}

function safeJson(s) {
	try { return JSON.parse(s); }
	catch { return null; }
}

function safeEventFromBody(body) {
	try {
		const obj = JSON.parse(body);
		return obj.event ?? 'unknown';
	}
	catch { return 'unknown'; }
}

function truncate(s) {
	if (typeof s !== 'string') return String(s);
	return s.length > MAX_LOG_REASON_LEN ? `${s.slice(0, MAX_LOG_REASON_LEN)}…` : s;
}

export const POLLER_CONSTANTS = Object.freeze({
	DEFAULT_WEBHOOK_TIMEOUT_MS
});
