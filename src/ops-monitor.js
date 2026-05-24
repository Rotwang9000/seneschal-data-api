// Pure helpers for the ops watchdog (seneschal-ops-monitor).
//
// The watchdog lives in `scripts/seneschal-ops-monitor.mjs` and
// uses these helpers so the parsing + state-delta + Telegram-message
// formatting logic can be unit-tested without invoking systemd.
//
// Health model:
//   * Each unit is classified as one of:
//       "ok"          — active or last-run succeeded recently
//       "stale"       — timer hasn't fired in too long
//       "failed"      — systemctl is-failed reports failed
//       "unknown"     — systemctl returned junk / couldn't be parsed
//   * Each script-presence check is "ok" / "missing".
//   * Overall status is the worst of any individual.
//
// Why a separate watchdog rather than systemd's built-in OnFailure?
//   * OnFailure only fires on the failed→running transition; it
//     doesn't alert on "this timer hasn't fired for 24h" or "this
//     script went missing".
//   * We want a single deduplicated alert per state-change rather
//     than one per tick. The watchdog stores its prior view on disk
//     and only emits when something CHANGED.
//   * Telegram is optional; the watchdog stays useful (journal
//     warnings + JSON state file the REST API can serve) even with
//     no bot configured.

/**
 * Parse the output of `systemctl show <unit> -p
 * ActiveState,SubState,Result,LastTriggerUSec,NRestarts,UnitFileState`
 * into an object. The `show` output is one `KEY=VALUE` per line.
 * Unknown keys are kept verbatim; missing keys are simply absent.
 */
export function parseShowOutput(text) {
	const out = {};
	for (const ln of String(text ?? '').split('\n')) {
		const eq = ln.indexOf('=');
		if (eq < 1) continue;
		const k = ln.slice(0, eq).trim();
		const v = ln.slice(eq + 1).trim();
		if (k) out[k] = v;
	}
	return out;
}

const TIMER_STALE_GRACE_MS = 5 * 60 * 1000;
// systemd Result values that mean the most recent invocation
// failed. `success` and `oneshot` (oneshot finished cleanly with
// RemainAfterExit=no) both mean "ok". Anything else is a failure.
const FAIL_RESULTS = new Set(['failed', 'exit-code', 'core-dump', 'timeout', 'signal', 'watchdog', 'oom-kill', 'protocol', 'resources']);
// ActiveStates that are TRANSIENT and legitimate — a tick that
// happens to land inside one of these (e.g. systemd just told the
// unit to start, node hasn't booted yet) must not flap the
// watchdog. We trust `Result` from the previous invocation
// instead.
const TRANSIENT_ACTIVE_STATES = new Set(['activating', 'deactivating', 'reloading', 'refreshing', 'maintenance']);

/**
 * Parse a `LastTriggerUSec` (or any `*USec`) value from
 * `systemctl show`. Tolerates the three known output formats:
 *
 *   * `"1716543662000000"`         — raw microseconds since epoch
 *                                    (rare, requires `--timestamp=us`
 *                                    or programmatic D-Bus reads)
 *   * `"@1716543662.531"`          — `--timestamp=unix` output
 *   * `"Sun 2026-05-24 09:51:02 CEST"` — default human-readable
 *
 * Returns milliseconds since epoch, or `null` if the value is
 * absent / unparseable. Used by `classifyUnit` for the
 * timer-staleness check; the prior version silently returned 0
 * for the human-readable case, defeating the check entirely.
 */
export function parseSystemdTimestampMs(value) {
	if (value == null) return null;
	const s = String(value).trim();
	if (!s) return null;
	// Numeric microseconds since epoch.
	if (/^\d+$/.test(s)) {
		const n = Number(s);
		if (!Number.isFinite(n) || n <= 0) return null;
		return Math.floor(n / 1000);
	}
	// `--timestamp=unix` format: "@<seconds>[.<micros>]".
	if (s.startsWith('@')) {
		const seconds = parseFloat(s.slice(1));
		if (!Number.isFinite(seconds) || seconds <= 0) return null;
		return Math.round(seconds * 1000);
	}
	// Default human-readable. Date.parse handles most timezone
	// abbreviations on the common platforms; `n/a` and `0` and
	// other systemd "no value yet" placeholders fall through to
	// null below.
	if (s === 'n/a' || s === '0' || s === '-') return null;
	const ms = Date.parse(s);
	if (!Number.isFinite(ms) || ms <= 0) return null;
	return ms;
}

/**
 * Classify a single unit's parsed `systemctl show` output. The
 * caller passes both the .service and (optionally) the .timer show
 * output so we can decide "is failed" + "has the timer fired
 * recently enough". For service units that DON'T have a paired
 * timer (e.g. seneschal-data-rest.service which is long-running),
 * pass `timer` as null and we'll judge by ActiveState alone.
 *
 * `expected.intervalMs` is the expected timer cadence (e.g. 600_000
 * for a 10-minute timer). We add a 5-minute grace before flagging
 * stale.
 *
 * Decision tree:
 *   1. Hard failure signal: `service.Result ∈ FAIL_RESULTS` AND
 *      `ExecMainStatus !== '0'` → failed. (A oneshot can momentarily
 *      report `Result=exit-code` even with status=0 on some systemd
 *      versions; honour the actual exit code.)
 *   2. Active+failed combo (long-running crash loop): `ActiveState=failed`.
 *   3. Timer-paired oneshot: trust `Result=success` as definitive
 *      ok even if the unit is mid-`activating`. This avoids flapping
 *      every time the watchdog tick races a timer fire.
 *   4. Timer-paired with stale `LastTriggerUSec` → stale.
 *   5. Long-running: `ActiveState=active && SubState=running` → ok.
 *   6. Transient ActiveStates (activating/deactivating/etc) → ok
 *      with a noted reason; they're never "unknown".
 *   7. Otherwise unknown (which we still treat as degraded so it
 *      gets investigated, but doesn't read as a flat-out failure).
 */
export function classifyUnit({ service, timer, expected, nowMs }) {
	if (!service || typeof service !== 'object') {
		return { status: 'unknown', reason: 'no service show data' };
	}
	const exitOk = service.ExecMainStatus == null || String(service.ExecMainStatus) === '0';
	const resultBad = FAIL_RESULTS.has(service.Result);
	// 1) + 2): hard failure.
	if ((resultBad && !exitOk) || service.ActiveState === 'failed') {
		return {
			status: 'failed',
			reason: `ActiveState=${service.ActiveState} Result=${service.Result} ExecMainStatus=${service.ExecMainStatus ?? 'n/a'} SubState=${service.SubState}`
		};
	}
	// 3) + 4): timer-paired logic.
	if (timer && expected?.intervalMs) {
		const lastMs = parseSystemdTimestampMs(timer.LastTriggerUSec);
		if (lastMs != null) {
			const age = nowMs - lastMs;
			if (age > expected.intervalMs + TIMER_STALE_GRACE_MS) {
				return {
					status: 'stale',
					reason: `timer last fired ${Math.round(age / 60000)} min ago (cadence ${Math.round(expected.intervalMs / 60000)} min)`
				};
			}
		}
		// For a timer-paired oneshot, the SERVICE almost always
		// looks `inactive/dead` between fires. `Result=success`
		// from the previous fire is the strongest signal we have.
		if (service.Result === 'success') {
			return {
				status: 'ok',
				reason: `oneshot Result=success ActiveState=${service.ActiveState} SubState=${service.SubState}`
			};
		}
	}
	// 5): long-running pattern.
	if (service.ActiveState === 'active' && service.SubState === 'running') {
		return { status: 'ok', reason: 'ActiveState=active SubState=running' };
	}
	// Oneshot inactive/dead with success result (e.g. data-rest
	// after a stop — shouldn't happen but be tolerant).
	if (service.ActiveState === 'inactive' && service.SubState === 'dead' && service.Result === 'success') {
		return { status: 'ok', reason: `ActiveState=inactive Result=success` };
	}
	// 6): transient legitimate states.
	if (TRANSIENT_ACTIVE_STATES.has(service.ActiveState)) {
		return {
			status: 'ok',
			reason: `transient ActiveState=${service.ActiveState} SubState=${service.SubState}`
		};
	}
	// 7): genuinely unrecognised.
	return {
		status: 'unknown',
		reason: `unrecognised state ActiveState=${service.ActiveState} Result=${service.Result} SubState=${service.SubState}`
	};
}

/**
 * Build the overall watchdog report from a map of per-unit
 * classifications + per-script presence checks. Returns:
 *   { overall: "ok"|"degraded", units: {...}, scripts: {...},
 *     summary: "human-readable one-liner" }
 */
export function buildReport({ units = {}, scripts = {}, nowMs }) {
	const unitEntries = Object.entries(units);
	const scriptEntries = Object.entries(scripts);
	const anyBad = (entries) => entries.some(([, v]) => v.status !== 'ok');
	const overall = (anyBad(unitEntries) || anyBad(scriptEntries)) ? 'degraded' : 'ok';

	const failingUnits = unitEntries.filter(([, v]) => v.status === 'failed').map(([k]) => k);
	const staleUnits = unitEntries.filter(([, v]) => v.status === 'stale').map(([k]) => k);
	const unknownUnits = unitEntries.filter(([, v]) => v.status === 'unknown').map(([k]) => k);
	const missingScripts = scriptEntries.filter(([, v]) => v.status !== 'ok').map(([k]) => k);

	let summary;
	if (overall === 'ok') {
		summary = `OK · ${unitEntries.length} units + ${scriptEntries.length} scripts healthy`;
	}
	else {
		const parts = [];
		if (failingUnits.length) parts.push(`${failingUnits.length} failed (${failingUnits.join(', ')})`);
		if (staleUnits.length) parts.push(`${staleUnits.length} stale (${staleUnits.join(', ')})`);
		if (unknownUnits.length) parts.push(`${unknownUnits.length} unknown (${unknownUnits.join(', ')})`);
		if (missingScripts.length) parts.push(`${missingScripts.length} script(s) missing (${missingScripts.join(', ')})`);
		// Defensive: if we somehow flipped to degraded with no
		// recognised buckets, surface that explicitly rather than
		// printing "DEGRADED · " (the bug the watchdog itself caught
		// on its first alert!).
		if (parts.length === 0) {
			parts.push(`${unitEntries.length} units + ${scriptEntries.length} scripts checked, no recognised failure bucket — investigate the full report`);
		}
		summary = `DEGRADED · ${parts.join('; ')}`;
	}
	return Object.freeze({
		overall,
		units,
		scripts,
		summary,
		generatedAtMs: nowMs
	});
}

/**
 * Compute the delta between a previous and current report. Returns
 * an array of human-readable change strings; empty array means "no
 * change worth alerting on". Used to deduplicate alerts.
 *
 * Changes detected:
 *   * Overall status flips (ok <-> degraded)
 *   * Any individual unit changes status (ok ↔ failed/stale/unknown)
 *   * Any script changes presence
 */
export function diffReports(prev, curr) {
	const changes = [];
	if (!prev) {
		if (curr.overall !== 'ok') {
			changes.push(`Initial watchdog state: ${curr.summary}`);
		}
		return changes;
	}
	if (prev.overall !== curr.overall) {
		changes.push(`Overall: ${prev.overall} → ${curr.overall}`);
	}
	const allUnitKeys = new Set([...Object.keys(prev.units ?? {}), ...Object.keys(curr.units ?? {})]);
	for (const k of allUnitKeys) {
		const p = prev.units?.[k]?.status ?? 'unknown';
		const c = curr.units?.[k]?.status ?? 'unknown';
		if (p !== c) changes.push(`Unit ${k}: ${p} → ${c} (${curr.units?.[k]?.reason ?? '—'})`);
	}
	const allScriptKeys = new Set([...Object.keys(prev.scripts ?? {}), ...Object.keys(curr.scripts ?? {})]);
	for (const k of allScriptKeys) {
		const p = prev.scripts?.[k]?.status ?? 'unknown';
		const c = curr.scripts?.[k]?.status ?? 'unknown';
		if (p !== c) changes.push(`Script ${k}: ${p} → ${c}`);
	}
	return changes;
}

/**
 * Render a short Telegram message body from a set of changes +
 * the current report. Telegram has a 4096-character limit per
 * message; we never approach it with this format.
 *
 * Format choices:
 *   * Short subject line (matches the alert kind)
 *   * Per-change bullets
 *   * Final "current overall" line so the reader doesn't have to
 *     piece state together from deltas alone.
 */
export function renderTelegramMessage({ changes, report, host }) {
	const icon = report.overall === 'ok' ? '✅' : '⚠️';
	const lines = [`${icon} seneschal ${host ? `(${host}) ` : ''}ops change`];
	for (const c of changes) lines.push(`• ${c}`);
	lines.push('');
	lines.push(report.summary);
	return lines.join('\n');
}

/**
 * Minimal Telegram sender. Lazy fetch-binding so unit tests can
 * inject a stub without monkey-patching globals. No bot configured
 * (missing token or chat-id) ⇒ returns `{ sent: false, reason }`
 * silently so the watchdog still works as a journal-only tool.
 */
export async function sendTelegram({ botToken, chatId, text, fetchImpl }) {
	if (!botToken) return { sent: false, reason: 'no_bot_token' };
	if (!chatId) return { sent: false, reason: 'no_chat_id' };
	if (!text) return { sent: false, reason: 'empty_text' };
	const f = fetchImpl ?? globalThis.fetch;
	if (typeof f !== 'function') return { sent: false, reason: 'no_fetch' };
	const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
	const body = JSON.stringify({
		chat_id: chatId,
		text,
		disable_web_page_preview: true,
		// Plain text so we don't have to MarkdownV2-escape every
		// underscore in a unit name.
		parse_mode: undefined
	});
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), 10_000);
	try {
		const r = await f(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body,
			signal: ctrl.signal
		});
		const ok = r.ok;
		if (!ok) return { sent: false, reason: `http_${r.status}` };
		return { sent: true };
	}
	catch (err) {
		return { sent: false, reason: `network:${err?.message ?? String(err)}` };
	}
	finally {
		clearTimeout(t);
	}
}
