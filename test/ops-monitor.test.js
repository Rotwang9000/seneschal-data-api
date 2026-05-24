// Tests for the ops-monitor watchdog helpers. Pure logic, no
// systemd / no Telegram round-trip.

import { describe, test, expect } from '@jest/globals';

import {
	parseShowOutput,
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

describe('classifyUnit', () => {
	const NOW = 1_779_605_000_000;

	test('long-running service in ActiveState=active → ok', () => {
		const r = classifyUnit({
			service: { ActiveState: 'active', SubState: 'running', Result: 'success' },
			timer: null,
			expected: null,
			nowMs: NOW
		});
		expect(r.status).toBe('ok');
	});

	test('failed service → failed', () => {
		const r = classifyUnit({
			service: { ActiveState: 'failed', SubState: 'failed', Result: 'exit-code' },
			timer: null,
			expected: null,
			nowMs: NOW
		});
		expect(r.status).toBe('failed');
		expect(r.reason).toMatch(/ActiveState=failed/);
	});

	test('oneshot service that exited 0 → ok (timer drives it)', () => {
		const r = classifyUnit({
			service: { ActiveState: 'inactive', SubState: 'dead', Result: 'success' },
			timer: { LastTriggerUSec: String((NOW - 60_000) * 1000), ActiveState: 'active' },
			expected: { intervalMs: 600_000 },
			nowMs: NOW
		});
		expect(r.status).toBe('ok');
	});

	test('timer hasn\'t fired in too long → stale', () => {
		const r = classifyUnit({
			service: { ActiveState: 'inactive', SubState: 'dead', Result: 'success' },
			timer: { LastTriggerUSec: String((NOW - 3_600_000) * 1000), ActiveState: 'active' },
			expected: { intervalMs: 600_000 },
			nowMs: NOW
		});
		expect(r.status).toBe('stale');
		expect(r.reason).toMatch(/timer last fired/);
	});

	test('unknown service shape → unknown', () => {
		const r = classifyUnit({ service: null, timer: null, expected: null, nowMs: NOW });
		expect(r.status).toBe('unknown');
	});

	test('grace window (5 min) tolerates timer slippage', () => {
		const r = classifyUnit({
			service: { ActiveState: 'inactive', SubState: 'dead', Result: 'success' },
			timer: { LastTriggerUSec: String((NOW - 12 * 60_000) * 1000) },
			expected: { intervalMs: 10 * 60_000 }, // 10 min cadence
			nowMs: NOW
		});
		// 12 min ago is within 10 + 5 grace, so it's still ok.
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
