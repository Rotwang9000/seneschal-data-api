// Tests for the pure-function business logic in private-watch.js.
// All inputs/outputs are plain JS objects; no DB, no network. Covers
// validation (happy + bad paths), SSRF guard, balance diffing, and
// webhook payload shape.

import { describe, test, expect } from '@jest/globals';

import {
	validateWatchRequest,
	assertWebhookUrlSafe,
	diffBalance,
	buildWebhookBody,
	buildWatchSummary,
	buildPrivateInfo,
	WATCH_CONSTANTS
} from '../src/private-watch.js';

const XMR_ADDR = '4' + 'A'.repeat(94);
const XMR_VK = '5'.repeat(64);
const ZEC_UADDR = 'u1' + 'q'.repeat(100);
const ZEC_UFVK = 'uview1' + 'q'.repeat(400);

describe('validateWatchRequest — monero', () => {
	test('accepts a well-formed request', () => {
		const out = validateWatchRequest({
			chain: 'monero',
			address: XMR_ADDR,
			viewKey: XMR_VK,
			webhookUrl: 'https://example.com/hook'
		});
		expect(out.chain).toBe('monero');
		expect(out.durationDays).toBe(WATCH_CONSTANTS.DEFAULT_DURATION_DAYS);
		expect(out.durationMs).toBe(WATCH_CONSTANTS.DEFAULT_DURATION_DAYS * 86_400_000);
		expect(out.birthdayHeight).toBeNull();
	});

	test('honours an explicit durationDays in range', () => {
		const out = validateWatchRequest({
			chain: 'monero',
			address: XMR_ADDR,
			viewKey: XMR_VK,
			webhookUrl: 'https://example.com/hook',
			durationDays: 14
		});
		expect(out.durationDays).toBe(14);
	});

	test('rejects out-of-range durationDays', () => {
		expect(() => validateWatchRequest({
			chain: 'monero',
			address: XMR_ADDR,
			viewKey: XMR_VK,
			webhookUrl: 'https://example.com/hook',
			durationDays: 0
		})).toThrow(/durationDays must be/);
		expect(() => validateWatchRequest({
			chain: 'monero',
			address: XMR_ADDR,
			viewKey: XMR_VK,
			webhookUrl: 'https://example.com/hook',
			durationDays: 100
		})).toThrow(/durationDays must be/);
	});

	test('rejects a short monero address', () => {
		expect(() => validateWatchRequest({
			chain: 'monero',
			address: '4short',
			viewKey: XMR_VK,
			webhookUrl: 'https://example.com/hook'
		})).toThrow(/monero address/);
	});

	test('rejects a non-hex view key', () => {
		expect(() => validateWatchRequest({
			chain: 'monero',
			address: XMR_ADDR,
			viewKey: 'not-hex-at-all',
			webhookUrl: 'https://example.com/hook'
		})).toThrow(/viewKey must be 64 hex/);
	});
});

describe('validateWatchRequest — zcash', () => {
	test('accepts a well-formed UFVK request', () => {
		const out = validateWatchRequest({
			chain: 'zcash',
			address: ZEC_UADDR,
			viewKey: ZEC_UFVK,
			webhookUrl: 'https://example.com/hook',
			birthdayHeight: 3_042_000
		});
		expect(out.chain).toBe('zcash');
		expect(out.birthdayHeight).toBe(3_042_000);
	});

	test('rejects non-UFVK view key', () => {
		expect(() => validateWatchRequest({
			chain: 'zcash',
			address: ZEC_UADDR,
			viewKey: 'sk-something',
			webhookUrl: 'https://example.com/hook'
		})).toThrow(/UFVK/);
	});

	test('rejects bad birthdayHeight', () => {
		expect(() => validateWatchRequest({
			chain: 'zcash',
			address: ZEC_UADDR,
			viewKey: ZEC_UFVK,
			webhookUrl: 'https://example.com/hook',
			birthdayHeight: -1
		})).toThrow(/birthdayHeight/);
	});
});

describe('assertWebhookUrlSafe', () => {
	const valid = ['https://example.com/hook', 'http://example.com/hook', 'https://sub.domain.io/path?x=1'];
	for (const u of valid) {
		test(`accepts ${u}`, () => {
			expect(() => assertWebhookUrlSafe(u)).not.toThrow();
		});
	}

	const banned = [
		'http://localhost/',
		'http://127.0.0.1:6379',
		'http://0.0.0.0/',
		'http://169.254.169.254/latest/meta-data',
		'http://10.0.0.5/',
		'http://192.168.1.1/x',
		'http://172.16.0.1/',
		'http://172.31.0.1/',
		'http://0.0.0.0/'
	];
	for (const u of banned) {
		test(`rejects ${u}`, () => {
			expect(() => assertWebhookUrlSafe(u)).toThrow();
		});
	}

	test('rejects ftp scheme', () => {
		expect(() => assertWebhookUrlSafe('ftp://example.com/')).toThrow(/protocol/);
	});

	test('rejects garbage', () => {
		expect(() => assertWebhookUrlSafe('not a url')).toThrow();
	});

	test('allows private addresses when allowPrivate', () => {
		expect(() => assertWebhookUrlSafe('http://127.0.0.1/', { allowPrivate: true })).not.toThrow();
	});

	test('rejects over-length URL', () => {
		const big = 'https://example.com/' + 'a'.repeat(WATCH_CONSTANTS.WEBHOOK_URL_MAX_LEN);
		expect(() => assertWebhookUrlSafe(big)).toThrow(/exceeds/);
	});
});

describe('diffBalance', () => {
	test('returns null when there is no change', () => {
		const a = { balanceAtomic: '100', scannedHeight: 5, error: null };
		const b = { balanceAtomic: '100', scannedHeight: 5, error: null };
		expect(diffBalance(a, b)).toBeNull();
	});

	test('reports balance increase', () => {
		const before = { balanceAtomic: '100', scannedHeight: 5, error: null };
		const after = { balanceAtomic: '300', scannedHeight: 6, error: null };
		const d = diffBalance(before, after);
		expect(d.changed).toBe(true);
		expect(d.balance_changed).toBe(true);
		expect(d.delta_atomic).toBe('200');
		expect(d.before_atomic).toBe('100');
		expect(d.after_atomic).toBe('300');
	});

	test('reports first-complete scan even on zero balance', () => {
		const after = { balanceAtomic: '0', scannedHeight: 10, status: 'completed', scanProgress: 1, error: null };
		const d = diffBalance(null, after);
		expect(d).toBeTruthy();
		expect(d.first_complete).toBe(true);
		expect(d.delta_atomic).toBe('0');
	});

	test('reports error transitions', () => {
		const before = { balanceAtomic: '100', error: null };
		const after = { balanceAtomic: '100', error: 'lws: timeout' };
		const d = diffBalance(before, after);
		expect(d).toBeTruthy();
		expect(d.error_changed).toBe(true);
		expect(d.balance_changed).toBe(false);
	});

	test('returns null when after is null', () => {
		expect(diffBalance({}, null)).toBeNull();
	});
});

describe('buildWebhookBody', () => {
	test('serialises a balance_change payload', () => {
		const body = buildWebhookBody({
			watchId: 'w1',
			chain: 'monero',
			address: XMR_ADDR,
			before: { balanceAtomic: '100', chain: 'monero' },
			after: { balanceAtomic: '300', chain: 'monero', status: 'completed' },
			diff: {
				balance_changed: true,
				first_complete: false,
				delta_atomic: '200',
				before_atomic: '100',
				after_atomic: '300'
			},
			nowMs: 1_700_000_000_000
		});
		const obj = JSON.parse(body);
		expect(obj.event).toBe('balance_change');
		expect(obj.watchId).toBe('w1');
		expect(obj.chain).toBe('monero');
		expect(obj.delta.balance_atomic).toBe('200');
		expect(obj.timestamp).toBe(new Date(1_700_000_000_000).toISOString());
	});

	test('classifies a first-complete event', () => {
		const body = buildWebhookBody({
			watchId: 'w1',
			chain: 'zcash',
			address: ZEC_UADDR,
			before: null,
			after: { balanceAtomic: '0', chain: 'zcash', status: 'completed' },
			diff: { balance_changed: false, first_complete: true, delta_atomic: '0', before_atomic: '0', after_atomic: '0' }
		});
		const obj = JSON.parse(body);
		expect(obj.event).toBe('scan_complete');
		expect(obj.previous).toBeNull();
	});
});

describe('buildWatchSummary', () => {
	test('strips sensitive fields and keeps state counters', () => {
		const row = {
			id: 'w1',
			token_hash: 'abc',
			view_key_ct: 'should-not-leak',
			webhook_url: 'https://secret.example/hook',
			webhook_secret: 'top-secret',
			chain: 'monero',
			created_at_ms: 1000,
			expires_at_ms: 8_000,
			cancelled: 0,
			dead: 0,
			delivery_attempts: 2,
			delivery_count: 5,
			last_polled_at_ms: 7000,
			last_delivered_at_ms: 6000,
			last_delivery_error: 'old timeout',
			last_known_balance: '{"balanceAtomic":"1"}',
			last_delivered_balance: '{"balanceAtomic":"0"}'
		};
		const out = buildWatchSummary(row, { nowMs: 4000 });
		expect(out.watchId).toBe('w1');
		expect(out.expires_in_ms).toBe(4000);
		expect(out.delivery_count).toBe(5);
		expect(out.last_known_balance).toEqual({ balanceAtomic: '1' });
		expect(out).not.toHaveProperty('view_key_ct');
		expect(out).not.toHaveProperty('webhook_secret');
		expect(out).not.toHaveProperty('webhook_url');
		expect(JSON.stringify(out)).not.toContain('top-secret');
		expect(JSON.stringify(out)).not.toContain('secret.example');
	});
});

describe('buildPrivateInfo', () => {
	test('reflects paywall configuration + chain support', () => {
		const info = buildPrivateInfo({
			x402Cfg: {
				enabled: true,
				routes: {
					'POST /v1/private/watch': { accepts: { price: '$0.10' } }
				}
			},
			nfptHealth: { ok: true }
		});
		expect(info.chains).toEqual(['monero', 'zcash']);
		expect(info.pricing.watch_creation).toBe('$0.10');
		expect(info.paywall_enabled).toBe(true);
		expect(info.upstream).toEqual({ ok: true });
	});

	test('handles disabled paywall', () => {
		const info = buildPrivateInfo({
			x402Cfg: { enabled: false },
			nfptHealth: { ok: false }
		});
		expect(info.pricing.watch_creation).toBeNull();
		expect(info.paywall_enabled).toBe(false);
	});
});
