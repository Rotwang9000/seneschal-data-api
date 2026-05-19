// Unit tests for src/x402.js. These cover the config validation and
// the describePaywall projection — both pure functions, no network.
// The dynamic @x402/fastify install is exercised end-to-end in the
// REST integration tests.

import { describe, test, expect } from '@jest/globals';
import { buildX402Config, describePaywall, PREMIUM_ROUTES } from '../src/x402.js';

const PAY_TO = '0x1234567890abcdef1234567890abcdef12345678';

function baseCfg(overrides = {}) {
	return {
		x402Enabled: true,
		x402RecipientAddress: PAY_TO,
		x402Network: 'eip155:8453',
		x402FacilitatorUrl: 'https://x402.org/facilitator',
		x402FeedPrice: '$0.05',
		x402MaxTimeoutSeconds: 120,
		x402PaywallDescription: 'premium liquidation feed',
		...overrides
	};
}

describe('buildX402Config', () => {
	test('returns disabled when recipient is unset', () => {
		const cfg = buildX402Config({ cfg: { ...baseCfg(), x402Enabled: false, x402RecipientAddress: '' }, env: {} });
		expect(cfg.enabled).toBe(false);
		expect(cfg.reason).toMatch(/RECIPIENT_ADDRESS/);
	});

	test('returns disabled when both env flag and recipient are blank', () => {
		const cfg = buildX402Config({ cfg: { ...baseCfg(), x402Enabled: false, x402RecipientAddress: '' }, env: {} });
		expect(cfg.enabled).toBe(false);
	});

	test('throws on malformed recipient', () => {
		expect(() => buildX402Config({
			cfg: baseCfg({ x402RecipientAddress: 'not-an-address' }),
			env: {}
		})).toThrow(/0x-prefixed 20-byte hex/);
	});

	test('throws on malformed network', () => {
		expect(() => buildX402Config({
			cfg: baseCfg({ x402Network: 'mainnet' }),
			env: {}
		})).toThrow(/CAIP-2/);
	});

	test('throws on missing facilitator URL', () => {
		expect(() => buildX402Config({
			cfg: baseCfg({ x402FacilitatorUrl: '' }),
			env: {}
		})).toThrow(/http\(s\)/);
	});

	test('throws on non-http facilitator URL', () => {
		expect(() => buildX402Config({
			cfg: baseCfg({ x402FacilitatorUrl: 'ipfs://something' }),
			env: {}
		})).toThrow(/http\(s\)/);
	});

	test('builds a routes map for every PREMIUM_ROUTES entry', () => {
		const cfg = buildX402Config({ cfg: baseCfg(), env: {} });
		expect(cfg.enabled).toBe(true);
		expect(cfg.recipient).toBe(PAY_TO);
		expect(cfg.network).toBe('eip155:8453');
		expect(cfg.facilitatorUrl).toBe('https://x402.org/facilitator');
		const routeKeys = Object.keys(cfg.routes);
		expect(routeKeys.length).toBe(PREMIUM_ROUTES.length);
		expect(routeKeys[0]).toBe('GET /v1/premium/opportunities');
		const r = cfg.routes['GET /v1/premium/opportunities'];
		expect(r.accepts.scheme).toBe('exact');
		expect(r.accepts.payTo).toBe(PAY_TO);
		expect(r.accepts.network).toBe('eip155:8453');
		expect(r.accepts.price).toBe('$0.05');
		expect(r.accepts.maxTimeoutSeconds).toBe(120);
		expect(r.mimeType).toBe('application/json');
		expect(typeof r.description).toBe('string');
		expect(r.description.length).toBeGreaterThan(20);
	});

	test('rejects non-money, non-atomic price strings', () => {
		expect(() => buildX402Config({
			cfg: baseCfg({ x402FeedPrice: 'free' }),
			env: {}
		})).toThrow(/X402_FEED_PRICE.*atomic-unit integer|X402_FEED_PRICE.*\$<dollars>/);
	});

	test('accepts atomic-unit price strings', () => {
		const cfg = buildX402Config({ cfg: baseCfg({ x402FeedPrice: '50000' }), env: {} });
		expect(cfg.routes['GET /v1/premium/opportunities'].accepts.price).toBe('50000');
	});

	test('environment X402_FEED_PRICE overrides cfg.x402FeedPrice', () => {
		const cfg = buildX402Config({
			cfg: baseCfg(),
			env: { X402_FEED_PRICE: '$0.25' }
		});
		expect(cfg.routes['GET /v1/premium/opportunities'].accepts.price).toBe('$0.25');
	});

	test('env-flag-only enable still produces a usable config', () => {
		// When the operator wants to flip x402 on without changing
		// recipient (e.g. for a dry-run on testnet), recipient is
		// still required — we never build a route without payTo.
		const cfg = buildX402Config({
			cfg: baseCfg({ x402Enabled: true }),
			env: {}
		});
		expect(cfg.enabled).toBe(true);
	});
});

describe('describePaywall', () => {
	test('returns null when disabled', () => {
		const cfg = buildX402Config({ cfg: { ...baseCfg(), x402Enabled: false, x402RecipientAddress: '' }, env: {} });
		expect(describePaywall(cfg)).toBeNull();
	});

	test('exposes per-route price + endpoint for the agent surface', () => {
		const cfg = buildX402Config({ cfg: baseCfg(), env: {} });
		const desc = describePaywall(cfg);
		expect(desc).not.toBeNull();
		expect(desc.protocol).toBe('x402');
		expect(desc.network).toBe('eip155:8453');
		expect(desc.payTo).toBe(PAY_TO);
		expect(desc.scheme).toMatch(/EIP-3009/);
		expect(desc.routes.length).toBe(PREMIUM_ROUTES.length);
		const route = desc.routes[0];
		expect(route.endpoint).toBe('GET /v1/premium/opportunities');
		expect(route.price).toBe('$0.05');
		expect(route.mime_type).toBe('application/json');
		expect(typeof route.description).toBe('string');
	});
});
