// Private-watch business logic.
//
// The data-api speaks six surfaces around watches:
//
//   POST /v1/private/watch    — paywalled, creates a fixed 7-day watch
//   GET  /v1/private/watch/:id  — owner-only, status + balance
//   DELETE /v1/private/watch/:id — owner-only, cancels
//   POST /v1/private/watch/:id/test — owner-only, fires a synthetic webhook
//   GET  /v1/private/info     — free, lists prices + chain availability
//   GET  /v1/private/health   — free, counters only (no PII)
//
// Everything in this module is pure: it validates inputs, builds
// records, and computes balance diffs. The side-effecty bits (DB
// writes, NFPT HTTP calls, webhook POSTs) live in the route handlers
// and the poller, so unit tests can exercise the contract without
// touching the network.
//
// SSRF rules: we accept user-supplied webhook URLs but defend against
// using them to probe our LAN. Three layers, in this file:
//   1. URL syntax + scheme allowlist (http/https only)
//   2. Hostname blocklist (loopback, metadata IPs, FORBIDDEN_HOSTNAMES)
//   3. IPv4 + IPv6 private-range checks on the literal hostname
// At creation time the rest-server.js handler additionally runs an
// async DNS lookup (see `resolveAndAssertWebhookSafe`) so a name like
// `evil.example.com` that resolves to 127.0.0.1 is also blocked.

import { URL } from 'node:url';
import { promises as dns } from 'node:dns';

// ── Tunables ─────────────────────────────────────────────────────

export const WATCH_CONSTANTS = Object.freeze({
	// Fixed tier: $0.10 buys 7 days. We deliberately ignore any
	// caller-supplied durationDays — variable pricing isn't supported
	// by the x402 paywall and accepting "give me 30 days for the
	// same $0.10" would just be giving stuff away. Multi-tier is a
	// future enhancement (separate paths each with their own price).
	FIXED_DURATION_DAYS: 7,
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
	WEBHOOK_URL_MAX_LEN: 2048,
	// Maximum bytes we'll buffer from a webhook response before
	// abandoning the read. Receivers should `200 OK` with a tiny
	// body; misbehaving ones can't tie up our poller with megabytes.
	WEBHOOK_RESPONSE_MAX_BYTES: 4 * 1024,
	// Bounds for the optional birthday/from-height (Monero scans back
	// to this height; Zcash starts scanning at NU6 if unspecified).
	// 50M comfortably covers Zcash mainnet (~3.5M) and Monero (~3.4M)
	// for the next decade without forcing a code change.
	MAX_BIRTHDAY_HEIGHT: 50_000_000,
	// Zcash NU6 mainnet activation height. We use this as a sane
	// default when a caller doesn't supply birthdayHeight so we
	// don't accidentally trigger an autoDetect or full re-scan.
	ZCASH_NU6_HEIGHT: 3_042_000
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
	'::',
	'metadata.google.internal',
	'169.254.169.254',
	'fd00::1',
	'fe80::1'
]);

const PRIVATE_IPV4_PREFIXES = [
	/^10\./u,
	/^192\.168\./u,
	/^172\.(1[6-9]|2\d|3[0-1])\./u,
	/^127\./u,
	/^169\.254\./u,
	/^0\./u,
	/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u // RFC6598 CGNAT 100.64.0.0/10
];

// Private IPv6 ranges per RFC4193/4291/6890. We canonicalise the
// IP first (lowercase, strip brackets) so the check is robust against
// the many ways an attacker could spell loopback ("::1", "[::1]",
// "::ffff:7f00:1" etc.).
function ipv6IsPrivate(rawAddr) {
	const addr = canonicaliseIpv6(rawAddr);
	if (addr === null) return false;
	if (addr === '::1' || addr === '::') return true;
	// fc00::/7 (unique local): first hextet starts 0xfc or 0xfd.
	if (/^fc[0-9a-f]{2}:|^fd[0-9a-f]{2}:/u.test(addr)) return true;
	// fe80::/10 (link-local): fe80..febf.
	if (/^fe[89ab][0-9a-f]:/u.test(addr)) return true;
	// IPv4-mapped IPv6 (::ffff:0:0/96) — re-check against IPv4 ranges.
	// URL parsing normalises dotted-quad inside IPv6 to hex words, so
	// we handle both `::ffff:127.0.0.1` and `::ffff:7f00:1` forms.
	const v4 = ipv4FromMappedIpv6(addr);
	if (v4 && PRIVATE_IPV4_PREFIXES.some((re) => re.test(v4))) return true;
	return false;
}

function canonicaliseIpv6(addr) {
	if (typeof addr !== 'string') return null;
	const stripped = addr.replace(/^\[|\]$/gu, '').toLowerCase();
	if (!stripped.includes(':')) return null;
	return stripped;
}

function ipv4FromMappedIpv6(addr) {
	const mixed = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u);
	if (mixed) return mixed[1];
	const hex = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
	if (hex) {
		const high = Number.parseInt(hex[1], 16);
		const low = Number.parseInt(hex[2], 16);
		return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join('.');
	}
	return null;
}

// ── Public surface ───────────────────────────────────────────────

/**
 * Validate an inbound POST /v1/private/watch body. Returns the
 * normalised input on success or throws a TypeError on failure (which
 * the rest-server error handler converts to 400).
 *
 * Inputs:
 *   { chain, address, viewKey, webhookUrl, birthdayHeight? }
 *
 * Note that `durationDays` is deliberately NOT accepted from the
 * caller — at the current single-tier price ($0.10 → 7 days) we
 * always use FIXED_DURATION_DAYS. If we ever ship multi-tier we'll
 * do it via distinct paths, each with its own x402 price.
 *
 * `birthdayHeight` is honoured for BOTH chains. Without it:
 *   - Zcash defaults to ZCASH_NU6_HEIGHT (sane for wallets newer than
 *     April 2024) — avoids a multi-hour autoDetect.
 *   - Monero uses NFPT's default (scanner starts from current height
 *     and reports the existing balance immediately).
 *
 * Output:
 *   { chain, address, viewKey, webhookUrl, durationMs, durationDays,
 *     birthdayHeight, now }
 */
export function validateWatchRequest(body, {
	now = Date.now(),
	allowPrivateWebhooks = false,
	requireHttps = false
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
	assertWebhookUrlSafe(webhookUrl, { allowPrivate: allowPrivateWebhooks, requireHttps });

	// Reject any attempt to widen the duration past the paid tier.
	// Quiet success on duplicates of the fixed value (lets clients
	// document their intent without erroring).
	if (body.durationDays !== undefined && body.durationDays !== null && body.durationDays !== '') {
		const n = Number(body.durationDays);
		if (!Number.isFinite(n) || n !== WATCH_CONSTANTS.FIXED_DURATION_DAYS) {
			throw new TypeError(
				`durationDays is fixed at ${WATCH_CONSTANTS.FIXED_DURATION_DAYS} for the current tier; do not supply, or pass exactly ${WATCH_CONSTANTS.FIXED_DURATION_DAYS}`
			);
		}
	}
	const durationDays = WATCH_CONSTANTS.FIXED_DURATION_DAYS;

	let birthdayHeight = null;
	if (body.birthdayHeight !== undefined && body.birthdayHeight !== null && body.birthdayHeight !== '') {
		const h = Number(body.birthdayHeight);
		if (!Number.isInteger(h) || h < 0 || h > WATCH_CONSTANTS.MAX_BIRTHDAY_HEIGHT) {
			throw new TypeError(`birthdayHeight must be an integer in [0, ${WATCH_CONSTANTS.MAX_BIRTHDAY_HEIGHT}] (got ${describe(body.birthdayHeight)})`);
		}
		birthdayHeight = h;
	}
	// Zcash: default to NU6 so the scanner never trips into autoDetect.
	// Most wallets are post-NU6 anyway; older ones can supply an
	// explicit birthdayHeight.
	if (chain === 'zcash' && birthdayHeight === null) {
		birthdayHeight = WATCH_CONSTANTS.ZCASH_NU6_HEIGHT;
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
 * Async DNS-aware variant of the validator. Same input/output as
 * `validateWatchRequest` but ALSO resolves the webhook hostname via
 * the system resolver and checks each returned IP against private
 * ranges. Reject `evil.example.com` whose A record points at
 * 127.0.0.1 — the literal-IP check alone would miss this class of
 * SSRF.
 *
 * The DNS lookups (one A, one AAAA) add ~5–80 ms; perfectly fine on
 * a one-shot watch creation, and very much worth the protection.
 *
 * `lookup` is dependency-injected so tests can stub it without a
 * fake DNS server. Defaults to node:dns/promises.
 */
export async function resolveAndValidateWatchRequest(body, {
	now = Date.now(),
	allowPrivateWebhooks = false,
	requireHttps = false,
	resolver = dns
} = {}) {
	const validated = validateWatchRequest(body, { now, allowPrivateWebhooks, requireHttps });
	if (!allowPrivateWebhooks) {
		await assertWebhookHostResolvesPublic(validated.webhookUrl, { resolver });
	}
	return validated;
}

/**
 * Resolve the webhook host's A + AAAA records and throw a TypeError
 * if any returned address is in a private/loopback range. Skips the
 * lookup if the hostname is already a literal IP (the synchronous
 * `assertWebhookUrlSafe` already covered those).
 */
export async function assertWebhookHostResolvesPublic(webhookUrl, { resolver = dns } = {}) {
	let url;
	try { url = new URL(webhookUrl); }
	catch { return; }
	const host = url.hostname.toLowerCase();
	// Already an IP literal? Sync guard covered it.
	if (/^[0-9.]+$/u.test(host) || host.includes(':')) return;
	const seen = [];
	const tryResolve = async (fn, kind) => {
		try {
			const ips = await fn(host);
			for (const ip of ips) seen.push({ kind, ip });
		}
		catch (err) {
			// NXDOMAIN, NODATA, network blip — leave the gate open;
			// the eventual delivery will fail naturally and we'd
			// rather not punish a freshly-created DNS record. We
			// log the error name so an operator can see why.
			if (err?.code !== 'ENODATA' && err?.code !== 'ENOTFOUND') throw err;
		}
	};
	await Promise.all([
		tryResolve(resolver.resolve4.bind(resolver), 'A'),
		tryResolve(resolver.resolve6.bind(resolver), 'AAAA')
	]);
	for (const { kind, ip } of seen) {
		if (kind === 'A' && PRIVATE_IPV4_PREFIXES.some((re) => re.test(ip))) {
			throw new TypeError(`webhookUrl host '${host}' resolves to private IPv4 ${ip}`);
		}
		if (kind === 'AAAA' && ipv6IsPrivate(ip)) {
			throw new TypeError(`webhookUrl host '${host}' resolves to private IPv6 ${ip}`);
		}
	}
}

/**
 * Assert that `webhookUrl` is safe to POST to. Throws a TypeError on
 * any violation; returns nothing on success.
 *
 * Rules:
 *   - parseable URL, length cap WEBHOOK_URL_MAX_LEN
 *   - http or https only (with optional `requireHttps`)
 *   - hostname not in FORBIDDEN_HOSTNAMES
 *   - IPv4 dotted hostname not in private/loopback/RFC6598 ranges
 *   - IPv6 literal not in ::/128, ::1, fc00::/7, fe80::/10, etc.
 *
 * This is the synchronous "obvious" guard. For DNS-based SSRF (an
 * attacker-controlled name that resolves to 127.0.0.1) use
 * `assertWebhookHostResolvesPublic` afterwards.
 */
export function assertWebhookUrlSafe(webhookUrl, { allowPrivate = false, requireHttps = false } = {}) {
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
	if (requireHttps && url.protocol !== 'https:') {
		throw new TypeError(`webhookUrl must use https:// in production (got ${url.protocol})`);
	}
	// Reject embedded credentials: keeps us from inadvertently
	// leaking basic-auth tokens that the receiver isn't expecting.
	if (url.username || url.password) {
		throw new TypeError('webhookUrl must not embed userinfo (https://user:pass@host…)');
	}
	const host = url.hostname.toLowerCase();
	if (allowPrivate) return;
	if (FORBIDDEN_HOSTNAMES.has(host)) {
		throw new TypeError(`webhookUrl host '${host}' is not allowed`);
	}
	// dotted-quad IPv4 — block private ranges.
	if (/^[0-9.]+$/u.test(host)) {
		if (PRIVATE_IPV4_PREFIXES.some((re) => re.test(host))) {
			throw new TypeError(`webhookUrl host '${host}' is in a private IPv4 range`);
		}
	}
	// IPv6 literal — block loopback/link-local/unique-local + v4-mapped.
	if (host.includes(':')) {
		if (ipv6IsPrivate(host)) {
			throw new TypeError(`webhookUrl host '${host}' is a private IPv6 address`);
		}
	}
}

/**
 * Build a synthetic webhook body for the /test endpoint. Same shape
 * as a real `balance_change` event but flagged via
 * `event: "synthetic_test"` so receivers can branch and avoid
 * processing it as a real payment.
 */
export function buildSyntheticTestBody({ watchId, chain, address, nowMs = Date.now() }) {
	return JSON.stringify({
		watchId,
		chain,
		address,
		event: 'synthetic_test',
		timestamp: new Date(nowMs).toISOString(),
		nonce: `test-${nowMs.toString(36)}`,
		previous: null,
		current: {
			chain,
			status: 'completed',
			balanceAtomic: '0',
			scannedHeight: 0,
			chainHeight: 0,
			percentComplete: 100,
			error: null,
			note: 'synthetic test event from /v1/private/watch/:id/test'
		},
		delta: { balance_atomic: '0', before_atomic: '0', after_atomic: '0' }
	});
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
 *
 * Derives `next_poll_eta_ms` from `last_polled_at_ms` + the poll
 * cadence so the caller knows roughly when the next scan tick will
 * fire (handy when integrating against a UI).
 */
export function buildWatchSummary(row, { nowMs = Date.now(), pollIntervalSec = WATCH_CONSTANTS.DEFAULT_POLL_INTERVAL_SEC } = {}) {
	if (!row) return null;
	const lastKnown = parseSnapshot(row.last_known_balance);
	const lastDelivered = parseSnapshot(row.last_delivered_balance);
	const lastPolled = row.last_polled_at_ms ?? null;
	const nextPollEta = lastPolled
		? Math.max(0, (lastPolled + pollIntervalSec * 1000) - nowMs)
		: null;
	return {
		watchId: row.id,
		chain: row.chain,
		created_at_ms: row.created_at_ms,
		expires_at_ms: row.expires_at_ms,
		expires_in_ms: Math.max(0, row.expires_at_ms - nowMs),
		cancelled: row.cancelled === 1,
		dead: row.dead === 1,
		last_polled_at_ms: lastPolled,
		next_poll_eta_ms: nextPollEta,
		last_delivered_at_ms: row.last_delivered_at_ms ?? null,
		last_delivered_event: row.last_delivered_event ?? null,
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
export function buildPrivateInfo({ x402Cfg, nfptHealth, requireHttps = false }) {
	const watchPrice = x402Cfg?.routes?.['POST /v1/private/watch']?.accepts?.price ?? null;
	return {
		service: 'Seneschal Private Watch',
		spec: 'view-key based payment monitoring with webhook delivery',
		chains: ['monero', 'zcash'],
		pricing: {
			watch_creation: watchPrice,
			duration_days: WATCH_CONSTANTS.FIXED_DURATION_DAYS,
			renewal: 're-POST the same payload to extend; each call buys a fresh window'
		},
		poll_interval_sec: WATCH_CONSTANTS.DEFAULT_POLL_INTERVAL_SEC,
		max_delivery_attempts: WATCH_CONSTANTS.MAX_DELIVERY_ATTEMPTS,
		paywall_enabled: x402Cfg?.enabled === true,
		upstream: nfptHealth,
		security: {
			view_key_encryption: 'AES-256-GCM with operator-supplied master key (PRIVATE_WATCH_ENCRYPTION_KEY)',
			webhook_signature: 'HMAC-SHA256 (per-watch secret in X-Seneschal-Signature: sha256=…)',
			webhook_url_scheme: requireHttps ? 'https only' : 'http or https',
			webhook_ssrf_guard: 'private IPv4/IPv6 ranges, loopback, link-local, RFC6598 CGNAT and cloud-metadata IPs are rejected at creation; the hostname is then DNS-resolved and the result re-checked',
			view_key_permissions: 'view keys grant read-only visibility into incoming transactions; they CANNOT spend funds. Handing one to a third-party service does not put your balance at risk.'
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
