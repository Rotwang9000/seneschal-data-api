// Tests for the OpenAPI discovery document. x402 indexers (x402scan)
// require /openapi.json and verify that each payable operation carries
// x-payment-info whose price agrees with the runtime 402 challenge,
// a declared 402 response, and a request schema for POST routes —
// so these tests pin exactly those properties.

import { describe, test, expect, beforeAll } from '@jest/globals';

import { buildOpenApiDocument, priceToAmount, inputsToParameters } from '../src/openapi.js';
import { buildX402Config } from '../src/x402.js';

const ENV = {
	X402_RECIPIENT_ADDRESS: '0x46Ba634261566CF242c853d1f49511f9268ba674',
	X402_NETWORK: 'eip155:8453',
	X402_Q_PRICE: '$0.001',
	X402_FEED_PRICE: '$0.05',
	X402_PRIVATE_WATCH_PRICE: '$0.10'
};

describe('priceToAmount', () => {
	test('strips the dollar prefix', () => {
		expect(priceToAmount('$0.001')).toBe('0.001');
		expect(priceToAmount('$5')).toBe('5');
	});

	test('passes through already-bare amounts and trims whitespace', () => {
		expect(priceToAmount(' 0.02 ')).toBe('0.02');
	});
});

describe('inputsToParameters', () => {
	test('expands required and optional query params', () => {
		const params = inputsToParameters(['builder', 'window?']);
		expect(params).toEqual([
			{ name: 'builder', in: 'query', required: true, schema: { type: 'string' } },
			{ name: 'window', in: 'query', required: false, schema: { type: 'string' } }
		]);
	});

	test('empty / missing inputs → no params', () => {
		expect(inputsToParameters([])).toEqual([]);
		expect(inputsToParameters(undefined)).toEqual([]);
	});
});

describe('buildOpenApiDocument (paywall enabled)', () => {
	let doc;
	beforeAll(() => {
		const cfg = {
			x402RecipientAddress: ENV.X402_RECIPIENT_ADDRESS,
			x402Network: ENV.X402_NETWORK,
			x402FacilitatorUrl: 'https://x402.org/facilitator'
		};
		const x402Cfg = buildX402Config({ cfg, env: ENV });
		expect(x402Cfg.enabled).toBe(true);
		doc = buildOpenApiDocument({ x402Cfg });
	});

	test('document skeleton: 3.1, server, guidance, contact', () => {
		expect(doc.openapi).toBe('3.1.0');
		expect(doc.servers[0].url).toBe('https://api.seneschal.space');
		expect(doc.info['x-guidance']).toMatch(/view key/i);
		expect(doc.info.contact.url).toMatch(/^https:/);
	});

	test('every paid route appears with x-payment-info and a 402 response', () => {
		const paidOps = [];
		for (const [path, methods] of Object.entries(doc.paths)) {
			for (const [, op] of Object.entries(methods)) {
				if (op['x-payment-info']) paidOps.push({ path, op });
			}
		}
		// 20 paid routes in the combined catalogue (5 watch/topup/historical
		// + 7 privacy facts + 8 DeFi/builder facts & feeds).
		expect(paidOps.length).toBeGreaterThanOrEqual(20);
		for (const { path, op } of paidOps) {
			expect(op.responses['402']).toBeDefined();
			const info = op['x-payment-info'];
			expect(info.protocols).toEqual([{ x402: {} }]);
			expect(info.price.mode).toBe('fixed');
			expect(info.price.currency).toBe('USD');
			expect(Number(info.price.amount)).toBeGreaterThan(0);
			expect(path.startsWith('/v1/')).toBe(true);
		}
	});

	test('price in the doc equals the runtime challenge price (no drift)', () => {
		const watch = doc.paths['/v1/private/watch'].post;
		expect(watch['x-payment-info'].price.amount).toBe('0.10');
		const fact = doc.paths['/v1/q/xmr/height'].get;
		expect(fact['x-payment-info'].price.amount).toBe('0.001');
	});

	test('POST routes carry request schemas with required fields', () => {
		const watchSchema = doc.paths['/v1/private/watch'].post.requestBody.content['application/json'].schema;
		expect(watchSchema.required).toEqual(['chain', 'address', 'viewKey', 'webhookUrl']);
		expect(watchSchema.properties.chain.enum).toEqual(['monero', 'zcash']);

		const topupSchema = doc.paths['/v1/private/topup'].post.requestBody.content['application/json'].schema;
		expect(topupSchema.required).toEqual(['watchId', 'watchToken']);
	});

	test('Penny-Oracle GETs expose their query parameters', () => {
		const bid = doc.paths['/v1/q/builder-bid'].get;
		const names = bid.parameters.map((p) => p.name);
		expect(names).toEqual(expect.arrayContaining(['builder', 'pct', 'window']));
		const required = bid.parameters.filter((p) => p.required).map((p) => p.name);
		expect(required).toEqual(['builder']);
	});

	test('free starter routes are present without x-payment-info', () => {
		for (const p of ['/v1/q', '/v1/paywall', '/v1/private/info']) {
			expect(doc.paths[p].get).toBeDefined();
			expect(doc.paths[p].get['x-payment-info']).toBeUndefined();
		}
		const derive = doc.paths['/v1/private/derive-viewkey'].post;
		expect(derive['x-payment-info']).toBeUndefined();
		expect(derive.requestBody.content['application/json'].schema.required).toEqual(['chain']);
	});
});

describe('buildOpenApiDocument (paywall disabled)', () => {
	test('still produces a valid doc with only the free routes', () => {
		const doc = buildOpenApiDocument({ x402Cfg: { enabled: false } });
		expect(doc.openapi).toBe('3.1.0');
		expect(doc.paths['/v1/q'].get).toBeDefined();
		const paidPaths = Object.values(doc.paths)
			.flatMap((m) => Object.values(m))
			.filter((op) => op['x-payment-info']);
		expect(paidPaths).toEqual([]);
	});
});
