// Tests for the ops-monitor watchdog helpers. Pure logic, no
// systemd / no Telegram round-trip.

import { describe, test, expect } from '@jest/globals';

import {
	parseShowOutput,
	parseSystemdTimestampMs,
	classifyUnit,
	buildReport,
	diffReports,
	renderTelegramMessage,
	sendTelegram
} from '../src/ops-monitor.js';

describe('parseShowOutput', () => {
	test('parses well-formed systemctl show output', () => {
		const out = parseShowOutput('ActiveState=active\nResult=success\nLastTriggerUSec=1700000000000000\n');
		expect(out.ActiveState).toBe('active');
		expect(out.Result).toBe('success');
		expect(out.LastTriggerUSec).toBe('1700000000000000');
	});

	test('skips blank lines + lines without =', () => {
		const out = parseShowOutput('\nrandomgarbage\nActiveState=inactive\n   \n');
		expect(out.ActiveState).toBe('inactive');
		expect(Object.keys(out)).toEqual(['ActiveState']);
	});

	test('handles values containing equals signs', () => {
		const out = parseShowOutput('Description=foo=bar=baz\n');
		expect(out.Description).toBe('foo=bar=baz');
	});

	test('returns empty for null / undefined / non-string inputs', () => {
		expect(parseShowOutput(null)).toEqual({});
		expect(parseShowOutput(undefined)).toEqual({});
		expect(parseShowOutput(123)).toEqual({});
	});
});

describe('parseSystemdTimestampMs', () => {
	test('null/empty/placeholder values return null', () => {
		expect(parseSystemdTimestampMs(null)).toBe(null);
		expect(parseSystemdTimestampMs(undefined)).toBe(null);
		expect(parseSystemdTimestampMs('')).toBe(null);
		expect(parseSystemdTimestampMs('  ')).toBe(null);
		expect(parseSystemdTimestampMs('n/a')).toBe(null);
		expect(parseSystemdTimestampMs('0')).toBe(null);
		expect(parseSystemdTimestampMs('-')).toBe(null);
	});

	test('raw microseconds-since-epoch (no flag, programmatic dbus)', () => {
		// 1_700_000_000 seconds = 1_700_000_000_000_000 us
		expect(parseSystemdTimestampMs('1700000000000000')).toBe(1_700_000_000_000);
	});

	test('@unix.subsec format (--timestamp=unix)', () => {
		expect(parseSystemdTimestampMs('@1700000000.5')).toBe(1_700_000_000_500);
		expect(parseSystemdTimestampMs('@1700000000')).toBe(1_700_000_000_000);
	});

	test('default human-readable format (--timestamp=pretty)', () => {
		// Real systemctl output. Date.parse handles RFC-2822-ish
		// with named timezones on V8.
		const ms = parseSystemdTimestampMs('Sun 2026-05-24 09:51:02 UTC');
		expect(ms).toBe(Date.UTC(2026, 4, 24, 9, 51, 2));
	});

	test('rejects garbage', () => {
		expect(parseSystemdTimestampMs('not a date')).toBe(null);
		expect(parseSystemdTimestampMs('@notanumber')).toBe(null);
		expect(parseSystemdTimestampMs('@-1')).toBe(null);
	});
});

describe('classifyUnit', () => {
	const NOW = 1_779_605_000_000;

	test('long-running service in ActiveState=active SubState=running → ok', () => {
		const r = classifyUnit({
			service: { ActiveState: 'active', SubState: 'running', Result: 'success', ExecMainStatus: '0' },
			timer: null,
			expected: null,
			nowMs: NOW
		});
		expect(r.status).toBe('ok');
	});

	test('failed service (ActiveState=failed) → failed', () => {
		const r = classifyUnit({
			service: { ActiveState: 'failed', SubState: 'failed', Result: 'exit-code', ExecMainStatus: '1' },
			timer: null,
			expected: null,
			nowMs: NOW
		});
		expect(r.status).toBe('failed');
		expect(r.reason).toMatch(/ActiveState=failed/);
		expect(r.reason).toMatch(/ExecMainStatus=1/);
	});

	test('Result=exit-code AND ExecMainStatus=0 → ok (transient systemd quirk)', () => {
		const r = classifyUnit({
			service: { ActiveState: 'inactive', SubState: 'dead', Result: 'exit-code', ExecMainStatus: '0' },
			timer: { LastTriggerUSec: '@' + ((NOW - 60_000) / 1000) },
			expected: { intervalMs: 600_000 },
			nowMs: NOW
		});
		// Exit 0 wins — Result=exit-code is just systemd's
		// label for "process exited normally rather than via
		// signal", not a failure.
		expect(r.status).not.toBe('failed');
	});

	test('oneshot service that exited 0 → ok (timer drives it)', () => {
		const r = classifyUnit({
			service: { ActiveState: 'inactive', SubState: 'dead', Result: 'success', ExecMainStatus: '0' },
			timer: { LastTriggerUSec: '@' + ((NOW - 60_000) / 1000) },
			expected: { intervalMs: 600_000 },
			nowMs: NOW
		});
		expect(r.status).toBe('ok');
	});

	test('mid-activation race window (ActiveState=activating SubState=start, Result=success from prior fire) → ok, NOT unknown', () => {
		// This is the exact false-positive that fired the first
		// real Telegram alert. The watchdog tick landed inside the
		// ~1ms window between the timer firing and node booting.
		// Result still reflects the previous successful invocation;
		// honour that.
		const r = classifyUnit({
			service: { ActiveState: 'activating', SubState: 'start', Result: 'success', ExecMainStatus: '0' },
			timer: { LastTriggerUSec: '@' + ((NOW - 1_000) / 1000) },
			expected: { intervalMs: 180_000 }, // 3-min poller
			nowMs: NOW
		});
		expect(r.status).toBe('ok');
		expect(r.reason).toMatch(/oneshot Result=success/);
	});

	test('first-ever fire (no prior Result yet, mid-activating) → ok via transient bucket', () => {
		const r = classifyUnit({
			service: { ActiveState: 'activating', SubState: 'start' },
			timer: null,
			expected: null,
			nowMs: NOW
		});
		expect(r.status).toBe('ok');
		expect(r.reason).toMatch(/transient/);
	});

	test('deactivating/reloading/maintenance treated as transient ok', () => {
		for (const s of ['deactivating', 'reloading', 'maintenance', 'refreshing']) {
			const r = classifyUnit({
				service: { ActiveState: s, SubState: 'whatever' },
				timer: null,
				expected: null,
				nowMs: NOW
			});
			expect(r.status).toBe('ok');
		}
	});

	test('timer hasn\'t fired in too long → stale', () => {
		const r = classifyUnit({
			service: { ActiveState: 'inactive', SubState: 'dead', Result: 'success', ExecMainStatus: '0' },
			timer: { LastTriggerUSec: '@' + ((NOW - 3_600_000) / 1000) },
			expected: { intervalMs: 600_000 },
			nowMs: NOW
		});
		expect(r.status).toBe('stale');
		expect(r.reason).toMatch(/timer last fired/);
	});

	test('staleness check works with human-readable LastTriggerUSec (real systemd output)', () => {
		// Previously broken — Number("Sun 2026...") was NaN so
		// the staleness check silently succeeded.
		const dateStr = new Date(NOW - 3_600_000).toUTCString();
		const r = classifyUnit({
			service: { ActiveState: 'inactive', SubState: 'dead', Result: 'success', ExecMainStatus: '0' },
			timer: { LastTriggerUSec: dateStr },
			expected: { intervalMs: 600_000 },
			nowMs: NOW
		});
		expect(r.status).toBe('stale');
	});

	test('unknown service shape → unknown', () => {
		const r = classifyUnit({ service: null, timer: null, expected: null, nowMs: NOW });
		expect(r.status).toBe('unknown');
	});

	test('grace window (5 min) tolerates timer slippage', () => {
		const r = classifyUnit({
			service: { ActiveState: 'inactive', SubState: 'dead', Result: 'success', ExecMainStatus: '0' },
			timer: { LastTriggerUSec: '@' + ((NOW - 12 * 60_000) / 1000) },
			expected: { intervalMs: 10 * 60_000 }, // 10 min cadence
			nowMs: NOW
		});
		expect(r.status).toBe('ok');
	});
});

describe('buildReport', () => {
	const NOW = 1_779_605_000_000;

	test('all-green report has overall=ok', () => {
		const r = buildReport({
			units: { a: { status: 'ok' }, b: { status: 'ok' } },
			scripts: { 'foo.mjs': { status: 'ok' } },
			nowMs: NOW
		});
		expect(r.overall).toBe('ok');
		expect(r.summary).toMatch(/OK ·/);
	});

	test('any failed unit makes overall=degraded', () => {
		const r = buildReport({
			units: { a: { status: 'ok' }, b: { status: 'failed', reason: 'boom' } },
			scripts: { 'foo.mjs': { status: 'ok' } },
			nowMs: NOW
		});
		expect(r.overall).toBe('degraded');
		expect(r.summary).toMatch(/1 failed \(b\)/);
	});

	test('any missing script makes overall=degraded', () => {
		const r = buildReport({
			units: { a: { status: 'ok' } },
			scripts: { 'foo.mjs': { status: 'missing' } },
			nowMs: NOW
		});
		expect(r.overall).toBe('degraded');
		expect(r.summary).toMatch(/1 script\(s\) missing \(foo\.mjs\)/);
	});

	test('stale + failed + missing combine into one summary', () => {
		const r = buildReport({
			units: { a: { status: 'failed' }, b: { status: 'stale' } },
			scripts: { 'x.mjs': { status: 'missing' }, 'y.mjs': { status: 'ok' } },
			nowMs: NOW
		});
		expect(r.summary).toMatch(/1 failed.*1 stale.*1 script/);
	});

	test('unknown units appear in the summary (regression: empty "DEGRADED · " bug)', () => {
		const r = buildReport({
			units: { z: { status: 'unknown', reason: 'r' } },
			scripts: {},
			nowMs: NOW
		});
		expect(r.summary).toMatch(/1 unknown \(z\)/);
		expect(r.summary).not.toMatch(/DEGRADED · $/);
	});

	test('degraded with no recognised failure bucket surfaces "investigate" hint', () => {
		// Synthetic edge case — should never happen in practice
		// because buildReport's overall=degraded predicate is
		// `anyBad`, so by definition there's a bad entry — but
		// belt-and-braces in case the predicate diverges.
		const r = buildReport({
			units: { a: { status: 'weird-future-state' } },
			scripts: {},
			nowMs: NOW
		});
		expect(r.overall).toBe('degraded');
		expect(r.summary).toMatch(/investigate the full report/);
	});
});

describe('diffReports', () => {
	test('first ever report (prev=null) emits only when degraded', () => {
		const ok = buildReport({ units: { a: { status: 'ok' } }, scripts: {}, nowMs: 0 });
		expect(diffReports(null, ok)).toEqual([]);
		const bad = buildReport({ units: { a: { status: 'failed' } }, scripts: {}, nowMs: 0 });
		expect(diffReports(null, bad)).toEqual([expect.stringContaining('Initial watchdog state')]);
	});

	test('no change between identical reports → empty', () => {
		const r = buildReport({ units: { a: { status: 'ok' } }, scripts: {}, nowMs: 0 });
		expect(diffReports(r, r)).toEqual([]);
	});

	test('overall flip is reported', () => {
		const prev = buildReport({ units: { a: { status: 'ok' } }, scripts: {}, nowMs: 0 });
		const curr = buildReport({ units: { a: { status: 'failed' } }, scripts: {}, nowMs: 0 });
		const changes = diffReports(prev, curr);
		expect(changes).toContain('Overall: ok → degraded');
		expect(changes.some(c => /Unit a: ok → failed/.test(c))).toBe(true);
	});

	test('individual unit status changes reported with reason', () => {
		const prev = buildReport({ units: { x: { status: 'ok' } }, scripts: {}, nowMs: 0 });
		const curr = buildReport({ units: { x: { status: 'stale', reason: 'timer last fired 99 min ago' } }, scripts: {}, nowMs: 0 });
		const changes = diffReports(prev, curr);
		expect(changes.some(c => c.includes('Unit x: ok → stale') && c.includes('99 min'))).toBe(true);
	});

	test('script presence changes reported', () => {
		const prev = buildReport({ units: {}, scripts: { 'foo.mjs': { status: 'ok' } }, nowMs: 0 });
		const curr = buildReport({ units: {}, scripts: { 'foo.mjs': { status: 'missing' } }, nowMs: 0 });
		const changes = diffReports(prev, curr);
		expect(changes).toContain('Script foo.mjs: ok → missing');
	});

	test('recovery (degraded→ok) emits the flip', () => {
		const prev = buildReport({ units: { a: { status: 'failed' } }, scripts: {}, nowMs: 0 });
		const curr = buildReport({ units: { a: { status: 'ok' } }, scripts: {}, nowMs: 0 });
		expect(diffReports(prev, curr)).toContain('Overall: degraded → ok');
	});
});

describe('renderTelegramMessage', () => {
	test('green report icon + summary', () => {
		const report = buildReport({ units: { a: { status: 'ok' } }, scripts: {}, nowMs: 0 });
		const text = renderTelegramMessage({ changes: ['Overall: degraded → ok'], report, host: 'fin4' });
		expect(text).toMatch(/^✅ seneschal \(fin4\) ops change/);
		expect(text).toMatch(/Overall: degraded → ok/);
		expect(text).toMatch(/OK ·/);
	});

	test('degraded report icon + bulleted changes', () => {
		const report = buildReport({ units: { a: { status: 'failed', reason: 'r' } }, scripts: {}, nowMs: 0 });
		const text = renderTelegramMessage({ changes: ['Unit a: ok → failed (r)'], report, host: null });
		expect(text).toMatch(/^⚠️ seneschal ops change/);
		expect(text).toMatch(/• Unit a: ok → failed/);
	});
});

describe('sendTelegram', () => {
	test('no bot token → silent no-op', async () => {
		const out = await sendTelegram({ botToken: null, chatId: '123', text: 'x' });
		expect(out).toEqual({ sent: false, reason: 'no_bot_token' });
	});

	test('no chat id → silent no-op', async () => {
		const out = await sendTelegram({ botToken: 'abc', chatId: '', text: 'x' });
		expect(out).toEqual({ sent: false, reason: 'no_chat_id' });
	});

	test('empty text → silent no-op', async () => {
		const out = await sendTelegram({ botToken: 'abc', chatId: '123', text: '' });
		expect(out).toEqual({ sent: false, reason: 'empty_text' });
	});

	test('successful POST returns { sent: true } and uses bot URL', async () => {
		const calls = [];
		const stub = async (url, opts) => {
			calls.push({ url, opts });
			return { ok: true, status: 200 };
		};
		const out = await sendTelegram({ botToken: 'BOT', chatId: 'CHAT', text: 'hi', fetchImpl: stub });
		expect(out).toEqual({ sent: true });
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe('https://api.telegram.org/botBOT/sendMessage');
		const body = JSON.parse(calls[0].opts.body);
		expect(body).toEqual(expect.objectContaining({ chat_id: 'CHAT', text: 'hi', disable_web_page_preview: true }));
	});

	test('HTTP error → returns reason http_*', async () => {
		const stub = async () => ({ ok: false, status: 429 });
		const out = await sendTelegram({ botToken: 'B', chatId: 'C', text: 'x', fetchImpl: stub });
		expect(out).toEqual({ sent: false, reason: 'http_429' });
	});

	test('network error → returns reason network:*', async () => {
		const stub = async () => { throw new Error('refused'); };
		const out = await sendTelegram({ botToken: 'B', chatId: 'C', text: 'x', fetchImpl: stub });
		expect(out.sent).toBe(false);
		expect(out.reason).toMatch(/^network:refused/);
	});
});
