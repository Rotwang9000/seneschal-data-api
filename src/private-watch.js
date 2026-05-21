// Private-watch business logic.
//
// The data-api speaks five surfaces around watches:
//
//   POST /v1/private/watch    — paywalled, creates a 7-day watch
//   GET  /v1/private/watch/:id  — owner-only, status + balance
//   DELETE /v1/private/watch/:id — owner-only, cancels
//   GET  /v1/private/info     — free, lists prices + chain availability
//   GET  /v1/private/health   — free, counters only (no PII)
//
// Everything in this module is pure: it validates inputs, builds
// records, and computes balance diffs. The side-effecty bits (DB
// writes, NFPT HTTP calls, webhook POSTs) live in the route handlers
// and the poller, so unit tests can exercise the contract without
// touching the network.

import { URL } from 'node:url';

// ── Tunables ─────────────────────────────────────────────────────

export const WATCH_CONSTANTS = Object.freeze({
	// One fixed tier for now: $0.10 buys 7 days of monitoring for one
	// (chain, address, viewKey, webhookUrl) tuple. Multi-tier comes
	// later when we have usage data to size it from.
	DEFAULT_DURATION_DAYS: 7,
	MIN_DURATION_DAYS: 1,
	MAX_DURATION_DAYS: 30,
	// Poll cadence — NFPT detaches a scanner after 5 min idle, so we
	// stay comfortably under that ceiling.
	DEFAULT_POLL_INTERVAL_SEC: 180,
	// How many consecutive webhook failures before we give up.
	// 50 attempts × 3-min poll ≈ 2.5 h of failures, which is enough
	// for a brief outage but short enough that a wrongly-configured
	// receiver doesn't pin a poller slot forever.
	MAX_DELIVERY_ATTEMPTS: 50,
	// Schema bounds we sanity-check user input against.
	XMR_VIEWKEY_HEX_LEN: 64,
	XMR_ADDRESS_MIN_LEN: 90,
	XMR_ADDRESS_MAX_LEN: 110,
	ZEC_UFVK_PREFIX: 'uview1',
	ZEC_ADDRESS_PREFIXES: Object.freeze(['u1', 't1', 't3', 'zs1', 'u1q']),
	WEBHOOK_BODY_MAX_BYTES: 64 * 1024,
	WEBHOOK_URL_MAX_LEN: 2048
});

// Hosts/IPs we won't deliver webhooks to. SSRF protection: agents
// pass us their callback URL and we POST to it from inside our LAN.
// A malicious caller pointing it at `http://127.0.0.1:6379` would let
// them probe our internal services. Block private ranges + the usual
// loopback aliases.
const FORBIDDEN_HOSTNAMES = new Set([
	'localhost',
	'localhost.localdomain',
	'127.0.0.1',
	'0.0.0.0',
	'::1',
	'metadata.google.internal',
	'169.254.169.254'
]);

const PRIVATE_IPV4_PREFIXES = [
	/^10\./u,
	/^192\.168\./u,
	/^172\.(1[6-9]|2\d|3[0-1])\./u,
	/^127\./u,
	/^169\.254\./u,
	/^0\./u
];

// ── Public surface ───────────────────────────────────────────────

/**
 * Validate an inbound POST /v1/private/watch body. Returns the
 * normalised input on success or throws a TypeError on failure (which
 * the rest-server error handler converts to 400).
 *
 * Inputs:
 *   { chain, address, viewKey, webhookUrl, durationDays?, birthdayHeight? }
 *
 * Output:
 *   { chain, address, viewKey, webhookUrl, durationMs, birthdayHeight }
 */
export function validateWatchRequest(body, {
	now = Date.now(),
	allowPrivateWebhooks = false
} = {}) {
	if (!body || typeof body !== 'object') {
		throw new TypeError('watch request body must be an object');
	}
	const chain = String(body.chain ?? '').toLowerCase();
	if (!['monero', 'zcash'].includes(chain)) {
		throw new TypeError(`chain must be 'monero' or 'zcash' (got ${describe(body.chain)})`);
	}
	const address = String(body.address ?? '').trim();
	const viewKey = String(body.viewKey ?? '').trim();
	if (!address) throw new TypeError('address is required');
	if (!viewKey) throw new TypeError('viewKey is required');

	if (chain === 'monero') {
		if (address.length < WATCH_CONSTANTS.XMR_ADDRESS_MIN_LEN
			|| address.length > WATCH_CONSTANTS.XMR_ADDRESS_MAX_LEN
			|| !/^[1-9A-HJ-NP-Za-km-z]+$/u.test(address)) {
			throw new TypeError(`monero address looks malformed (length=${address.length})`);
		}
		if (!/^[0-9a-fA-F]+$/u.test(viewKey) || viewKey.length !== WATCH_CONSTANTS.XMR_VIEWKEY_HEX_LEN) {
			throw new TypeError(`monero viewKey must be ${WATCH_CONSTANTS.XMR_VIEWKEY_HEX_LEN} hex chars`);
		}
	}
	else {
		if (!WATCH_CONSTANTS.ZEC_ADDRESS_PREFIXES.some((p) => address.startsWith(p))) {
			throw new TypeError(`zcash address must start with one of ${WATCH_CONSTANTS.ZEC_ADDRESS_PREFIXES.join(', ')}`);
		}
		if (!viewKey.startsWith(WATCH_CONSTANTS.ZEC_UFVK_PREFIX) && !viewKey.startsWith('uview')) {
			throw new TypeError(`zcash viewKey must be a UFVK (starts with '${WATCH_CONSTANTS.ZEC_UFVK_PREFIX}')`);
		}
	}

	const webhookUrl = String(body.webhookUrl ?? '').trim();
	assertWebhookUrlSafe(webhookUrl, { allowPrivate: allowPrivateWebhooks });

	let durationDays = WATCH_CONSTANTS.DEFAULT_DURATION_DAYS;
	if (body.durationDays !== undefined && body.durationDays !== null && body.durationDays !== '') {
		const n = Number(body.durationDays);
		if (!Number.isFinite(n) || n < WATCH_CONSTANTS.MIN_DURATION_DAYS || n > WATCH_CONSTANTS.MAX_DURATION_DAYS) {
			throw new TypeError(
				`durationDays must be a number in [${WATCH_CONSTANTS.MIN_DURATION_DAYS}, ${WATCH_CONSTANTS.MAX_DURATION_DAYS}]`
			);
		}
		durationDays = Math.floor(n);
	}

	let birthdayHeight = null;
	if (chain === 'zcash' && body.birthdayHeight !== undefined && body.birthdayHeight !== null && body.birthdayHeight !== '') {
		const h = Number(body.birthdayHeight);
		if (!Number.isInteger(h) || h < 0 || h > 50_000_000) {
			throw new TypeError(`birthdayHeight must be a non-negative integer (got ${describe(body.birthdayHeight)})`);
		}
		birthdayHeight = h;
	}

	return Object.freeze({
		chain,
		address,
		viewKey,
		webhookUrl,
		durationDays,
		durationMs: durationDays * 86_400_000,
		birthdayHeight,
		now
	});
}

/**
 * Assert that `webhookUrl` is safe to POST to. Throws a TypeError on
 * any violation; returns nothing on success.
 *
 * Rules:
 *   - parseable URL
 *   - http or https only
 *   - hostname not in FORBIDDEN_HOSTNAMES
 *   - IPv4 dotted hostname not in private RFC1918 ranges
 *   - length cap WEBHOOK_URL_MAX_LEN
 */
export function assertWebhookUrlSafe(webhookUrl, { allowPrivate = false } = {}) {
	if (typeof webhookUrl !== 'string' || webhookUrl.length === 0) {
		throw new TypeError('webhookUrl is required');
	}
	if (webhookUrl.length > WATCH_CONSTANTS.WEBHOOK_URL_MAX_LEN) {
		throw new TypeError(`webhookUrl exceeds ${WATCH_CONSTANTS.WEBHOOK_URL_MAX_LEN} chars`);
	}
	let url;
	try { url = new URL(webhookUrl); }
	catch (e) { throw new TypeError(`webhookUrl is not a valid URL: ${e?.message ?? e}`); }
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new TypeError(`webhookUrl protocol must be http or https (got ${url.protocol})`);
	}
	const host = url.hostname.toLowerCase();
	if (allowPrivate) return;
	if (FORBIDDEN_HOSTNAMES.has(host)) {
		throw new TypeError(`webhookUrl host '${host}' is not allowed`);
	}
	// dotted-quad IPv4 — block private ranges. We don't resolve DNS
	// here (that would make validation network-dependent); a paranoid
	// op can add caddy-side egress filtering as belt-and-braces.
	if (/^[0-9.]+$/u.test(host)) {
		if (PRIVATE_IPV4_PREFIXES.some((re) => re.test(host))) {
			throw new TypeError(`webhookUrl host '${host}' is in a private IPv4 range`);
		}
	}
}

/**
 * Compute the diff between two balance snapshots. Returns:
 *   - `null` if there's no semantic difference (used to skip webhook
 *     delivery on idle ticks)
 *   - `{ changed: true, delta, before, after, summary }` otherwise.
 *
 * Snapshots are the objects produced by private-watch-nfpt.js's
 * `normaliseMonero` / `normaliseOrchard`.
 */
export function diffBalance(before, after) {
	if (!after) return null;
	const a = numericString(after.balanceAtomic);
	const b = before ? numericString(before.balanceAtomic) : null;
	const heightChanged = before
		&& Number(after.scannedHeight ?? 0) > Number(before.scannedHeight ?? 0);
	if (b === a && !before?.error !== !after?.error) {
		// status flag flipped (e.g. error → recovered) but no balance
		// change. We still want to emit on first-completion.
	}
	const balanceChanged = a !== null && a !== b;
	const errorChanged = (before?.error ?? null) !== (after?.error ?? null);
	const firstComplete = !before && (after?.status === 'completed' || after?.scanProgress >= 0.999);
	if (!balanceChanged && !errorChanged && !firstComplete) return null;
	const beforeAtomic = b ?? '0';
	const afterAtomic = a ?? '0';
	let delta = null;
	try { delta = (BigInt(afterAtomic) - BigInt(beforeAtomic)).toString(); }
	catch { delta = null; }
	return Object.freeze({
		changed: true,
		balance_changed: balanceChanged,
		error_changed: errorChanged,
		first_complete: firstComplete,
		height_changed: Boolean(heightChanged),
		before_atomic: beforeAtomic,
		after_atomic: afterAtomic,
		delta_atomic: delta
	});
}

/**
 * Build the JSON body of a webhook delivery. The receiver verifies
 * `X-Seneschal-Signature: sha256=<hex>` against the exact body bytes,
 * so the caller must hand the returned string verbatim to fetch.
 */
export function buildWebhookBody({ watchId, chain, address, before, after, diff, nowMs = Date.now() }) {
	const payload = {
		watchId,
		chain,
		address,
		event: diff.first_complete
			? 'scan_complete'
			: diff.balance_changed
				? 'balance_change'
				: 'status_change',
		timestamp: new Date(nowMs).toISOString(),
		nonce: `${nowMs.toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`,
		previous: before ? scrubSnapshot(before) : null,
		current: scrubSnapshot(after),
		delta: {
			balance_atomic: diff.delta_atomic,
			before_atomic: diff.before_atomic,
			after_atomic: diff.after_atomic
		}
	};
	return JSON.stringify(payload);
}

/**
 * Public summary that GET /v1/private/watch/:id returns. We strip
 * everything sensitive — no view key, no webhook URL, no secret — so
 * the agent can poll for status without leaking back to the receiver.
 */
export function buildWatchSummary(row, { nowMs = Date.now() } = {}) {
	if (!row) return null;
	const lastKnown = parseSnapshot(row.last_known_balance);
	const lastDelivered = parseSnapshot(row.last_delivered_balance);
	return {
		watchId: row.id,
		chain: row.chain,
		created_at_ms: row.created_at_ms,
		expires_at_ms: row.expires_at_ms,
		expires_in_ms: Math.max(0, row.expires_at_ms - nowMs),
		cancelled: row.cancelled === 1,
		dead: row.dead === 1,
		last_polled_at_ms: row.last_polled_at_ms ?? null,
		last_delivered_at_ms: row.last_delivered_at_ms ?? null,
		delivery_attempts: row.delivery_attempts ?? 0,
		delivery_count: row.delivery_count ?? 0,
		last_delivery_error: row.last_delivery_error ?? null,
		last_known_balance: lastKnown,
		last_delivered_balance: lastDelivered
	};
}

/**
 * Free metadata endpoint. Lists prices, chains, NFPT health summary.
 * Caller passes the upstream `nfptStatus` (true/false) so we don't
 * pull on the network from a pure function.
 */
export function buildPrivateInfo({ x402Cfg, nfptHealth }) {
	const watchPrice = x402Cfg?.routes?.['POST /v1/private/watch']?.accepts?.price ?? null;
	return {
		service: 'Seneschal Private Watch',
		spec: 'view-key based payment monitoring with webhook delivery',
		chains: ['monero', 'zcash'],
		pricing: {
			watch_creation: watchPrice,
			default_duration_days: WATCH_CONSTANTS.DEFAULT_DURATION_DAYS,
			min_duration_days: WATCH_CONSTANTS.MIN_DURATION_DAYS,
			max_duration_days: WATCH_CONSTANTS.MAX_DURATION_DAYS
		},
		poll_interval_sec: WATCH_CONSTANTS.DEFAULT_POLL_INTERVAL_SEC,
		paywall_enabled: x402Cfg?.enabled === true,
		upstream: nfptHealth,
		security: {
			view_key_encryption: 'AES-256-GCM with operator-supplied master key (PRIVATE_WATCH_ENCRYPTION_KEY)',
			webhook_signature: 'HMAC-SHA256 (per-watch secret in X-Seneschal-Signature: sha256=…)',
			webhook_ssrf_guard: 'private IPv4 ranges, localhost, and metadata IPs are rejected'
		}
	};
}

// ── Internal helpers ─────────────────────────────────────────────

function numericString(v) {
	if (v === null || v === undefined) return null;
	const s = String(v);
	return /^-?\d+$/u.test(s) ? s : null;
}

function scrubSnapshot(snap) {
	if (!snap || typeof snap !== 'object') return null;
	// Whitelist only the public fields. Avoids accidentally leaking
	// future internal state if normalise* grows new keys.
	return {
		chain: snap.chain ?? null,
		status: snap.status ?? null,
		balanceAtomic: snap.balanceAtomic ?? null,
		spendableAtomic: snap.spendableAtomic ?? null,
		lockedAtomic: snap.lockedAtomic ?? null,
		pendingInAtomic: snap.pendingInAtomic ?? null,
		pendingOutAtomic: snap.pendingOutAtomic ?? null,
		receivedAtomic: snap.receivedAtomic ?? null,
		unspentNotes: snap.unspentNotes ?? null,
		notes: snap.notes ?? null,
		scannedHeight: snap.scannedHeight ?? null,
		chainHeight: snap.chainHeight ?? null,
		percentComplete: snap.percentComplete ?? null,
		error: snap.error ?? null
	};
}

function parseSnapshot(json) {
	if (!json) return null;
	try { return JSON.parse(json); }
	catch { return null; }
}

function describe(v) {
	const s = typeof v === 'string' ? v : JSON.stringify(v);
	return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}
