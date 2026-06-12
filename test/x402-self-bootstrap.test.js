// Tests for the pure helpers in scripts/x402-self-bootstrap.mjs.
// The script's network/payment flow is exercised manually against
// production (it spends real, capped USDC); these tests pin down the
// parsing, redaction, and target-construction logic that the flow
// depends on.

import { describe, test, expect } from '@jest/globals';

import {
	parseArgs,
	decodeChallengeHeader,
	pickAccept,
	acceptAmountAtomic,
	atomicToUsd,
	redactSecrets,
	requestInit,
	buildPaymentsTargets
} from '../scripts/x402-self-bootstrap.mjs';

describe('parseArgs', () => {
	test('defaults: dry-run, default cap, no filters', () => {
		const o = parseArgs(['node', 'script']);
		expect(o.pay).toBe(false);
		expect(o.payments).toBe(false);
		expect(o.allPremium).toBe(false);
		expect(o.only).toBe(null);
		expect(o.maxUsd).toBeCloseTo(0.005);
	});

	test('flags and values are picked up', () => {
		const o = parseArgs(['node', 'script', '--pay', '--payments', '--max-usd', '0.12', '--only', 'watch']);
		expect(o.pay).toBe(true);
		expect(o.payments).toBe(true);
		expect(o.maxUsd).toBeCloseTo(0.12);
		expect(o.only).toBe('watch');
	});
});

describe('decodeChallengeHeader', () => {
	test('decodes a base64 x402 challenge', () => {
		const challenge = { x402Version: 2, accepts: [{ network: 'eip155:8453', amount: '1000' }] };
		const header = Buffer.from(JSON.stringify(challenge)).toString('base64');
		expect(decodeChallengeHeader(header)).toEqual(challenge);
	});

	test('null / garbage → null (no throw)', () => {
		expect(decodeChallengeHeader(null)).toBe(null);
		expect(decodeChallengeHeader('not-base64-json!!')).toBe(null);
	});
});

describe('pickAccept + amount helpers', () => {
	const challenge = {
		accepts: [
			{ network: 'eip155:1', amount: '999' },
			{ network: 'eip155:8453', amount: '100000' }
		]
	};

	test('prefers the accept matching our network', () => {
		const a = pickAccept(challenge, 'eip155:8453');
		expect(a.amount).toBe('100000');
	});

	test('falls back to the first accept when no network match', () => {
		const a = pickAccept(challenge, 'eip155:42161');
		expect(a.network).toBe('eip155:1');
	});

	test('no accepts → null', () => {
		expect(pickAccept({}, 'eip155:8453')).toBe(null);
		expect(pickAccept(null, 'eip155:8453')).toBe(null);
	});

	test('atomic amount parsing handles amount and maxAmountRequired', () => {
		expect(acceptAmountAtomic({ amount: '100000' })).toBe(100000n);
		expect(acceptAmountAtomic({ maxAmountRequired: '5000' })).toBe(5000n);
		expect(acceptAmountAtomic({})).toBe(null);
	});

	test('atomic → USD at 6 decimals', () => {
		expect(atomicToUsd(100000n)).toBeCloseTo(0.1);
		expect(atomicToUsd(1000n)).toBeCloseTo(0.001);
	});
});

describe('redactSecrets', () => {
	test('strips watchToken, webhookSecret and viewKey values', () => {
		const body = JSON.stringify({
			watchId: 'abc',
			watchToken: 'tok-secret',
			webhookSecret: 'whs-secret',
			viewKey: 'c0166…',
			chain: 'monero'
		});
		const out = redactSecrets(body);
		expect(out).not.toContain('tok-secret');
		expect(out).not.toContain('whs-secret');
		expect(out).not.toContain('c0166');
		expect(out).toContain('"watchId":"abc"');
		expect(out).toContain('"watchToken":"<redacted>"');
	});
});

describe('requestInit', () => {
	test('GET targets carry no body or content-type', () => {
		const init = requestInit({ method: 'GET', path: '/x' });
		expect(init).toEqual({ method: 'GET' });
	});

	test('POST targets serialise the body as JSON', () => {
		const init = requestInit({ method: 'POST', path: '/x', body: { a: 1 } });
		expect(init.method).toBe('POST');
		expect(init.headers['content-type']).toBe('application/json');
		expect(JSON.parse(init.body)).toEqual({ a: 1 });
	});
});

describe('buildPaymentsTargets', () => {
	const env = {
		SENESCHAL_XMR_RECV_ADDRESS: '4Bxxx',
		SENESCHAL_XMR_RECV_VIEW_KEY: 'c0xxx',
		SENESCHAL_XMR_RECV_FROM_HEIGHT: '3686932'
	};

	test('builds the watch target from env with birthday height', () => {
		const targets = buildPaymentsTargets(env);
		expect(targets).toHaveLength(1);
		const watch = targets[0];
		expect(watch.method).toBe('POST');
		expect(watch.path).toBe('/v1/private/watch');
		expect(watch.body.chain).toBe('monero');
		expect(watch.body.address).toBe('4Bxxx');
		expect(watch.body.birthdayHeight).toBe(3686932);
		expect(watch.body.webhookUrl).toMatch(/^https?:\/\//);
	});

	test('chains a topup bound to the created watch', () => {
		const [watch] = buildPaymentsTargets(env);
		const next = watch.chain({ watchId: 'w-1', watchToken: 't-1' });
		expect(next.method).toBe('POST');
		expect(next.path).toBe('/v1/private/topup');
		expect(next.body).toEqual({ watchId: 'w-1', watchToken: 't-1' });
	});

	test('chain returns null when the response lacks credentials', () => {
		const [watch] = buildPaymentsTargets(env);
		expect(watch.chain({})).toBe(null);
		expect(watch.chain(null)).toBe(null);
	});

	test('missing env throws the assertion (no silent half-config)', () => {
		expect(() => buildPaymentsTargets({})).toThrow(/SENESCHAL_XMR_RECV_ADDRESS/);
	});
});
