// Unit tests for src/x402.js. These cover the config validation and
// the describePaywall projection — both pure functions, no network.
// The dynamic @x402/fastify install is exercised end-to-end in the
// REST integration tests.

import { describe, test, expect } from '@jest/globals';
import { buildX402Config, describePaywall, discoveryConfigForRouteKey, createFacilitatorClient, CDP_FACILITATOR_URL, PREMIUM_ROUTES } from '../src/x402.js';
import { declareDiscoveryExtension, validateDiscoveryExtension } from '@x402/extensions/bazaar';
import { checkIfBazaarNeeded } from '@x402/core/server';

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
		// Lead route is the Private Watch product (privacy-coin first).
		expect(routeKeys[0]).toBe('POST /v1/private/watch');
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
		// x402FeedPrice is the global per-route fallback, so a bad value
		// trips assertPrice on the first route that falls back to it.
		// Assert on the input + reason, not the (route-dependent) env-key
		// name — the lead route can change without weakening this check.
		expect(() => buildX402Config({
			cfg: baseCfg({ x402FeedPrice: 'free' }),
			env: {}
		})).toThrow(/=free must be.*atomic-unit integer/);
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

	test('defaults to url facilitator mode with no CDP creds', () => {
		const cfg = buildX402Config({ cfg: baseCfg(), env: {} });
		expect(cfg.facilitatorMode).toBe('url');
		expect(cfg.facilitatorUrl).toBe('https://x402.org/facilitator');
	});

	test('switches to CDP facilitator mode when both CDP creds are present', () => {
		const cfg = buildX402Config({
			cfg: baseCfg({ x402CdpApiKeyId: 'key-id', x402CdpApiKeySecret: 'key-secret' }),
			env: {}
		});
		expect(cfg.facilitatorMode).toBe('cdp');
		// CDP mode pins the Coinbase facilitator URL, ignoring the
		// openx402 default — presence of keys is the unambiguous signal.
		expect(cfg.facilitatorUrl).toBe(CDP_FACILITATOR_URL);
	});

	test('stays in url mode when only one CDP cred is present (partial config is not CDP)', () => {
		const idOnly = buildX402Config({ cfg: baseCfg({ x402CdpApiKeyId: 'key-id' }), env: {} });
		expect(idOnly.facilitatorMode).toBe('url');
		expect(idOnly.facilitatorUrl).toBe('https://x402.org/facilitator');
		const secretOnly = buildX402Config({ cfg: baseCfg({ x402CdpApiKeySecret: 'key-secret' }), env: {} });
		expect(secretOnly.facilitatorMode).toBe('url');
	});
});

describe('createFacilitatorClient', () => {
	test('rejects in cdp mode when credentials are missing (before loading the x402 stack)', async () => {
		await expect(createFacilitatorClient(
			{ enabled: true, facilitatorMode: 'cdp', facilitatorUrl: CDP_FACILITATOR_URL },
			{ cfg: { x402CdpApiKeyId: '', x402CdpApiKeySecret: '' } }
		)).rejects.toThrow(/CDP API credentials are missing/);
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
		// Privacy-coin lead route heads the agent-facing discovery doc.
		expect(route.endpoint).toBe('POST /v1/private/watch');
		expect(route.price).toBe('$0.05');
		expect(route.mime_type).toBe('application/json');
		expect(typeof route.description).toBe('string');
	});

	test('reports facilitator_mode for the discovery surface', () => {
		const urlCfg = buildX402Config({ cfg: baseCfg(), env: {} });
		expect(describePaywall(urlCfg).facilitator_mode).toBe('url');

		const cdpCfg = buildX402Config({
			cfg: baseCfg({ x402CdpApiKeyId: 'a', x402CdpApiKeySecret: 'b' }),
			env: {}
		});
		const cdpDesc = describePaywall(cdpCfg);
		expect(cdpDesc.facilitator_mode).toBe('cdp');
		expect(cdpDesc.facilitator).toBe(CDP_FACILITATOR_URL);
	});
});

describe('discoveryConfigForRouteKey (bazaar discovery wiring)', () => {
	test('query (GET/HEAD/DELETE) routes get an empty config', () => {
		expect(discoveryConfigForRouteKey('GET /v1/q/xmr/height')).toEqual({});
		expect(discoveryConfigForRouteKey('GET /v1/premium/opportunities')).toEqual({});
	});

	test('body methods (POST/PUT/PATCH) declare bodyType json', () => {
		expect(discoveryConfigForRouteKey('POST /v1/private/watch')).toEqual({ bodyType: 'json' });
		expect(discoveryConfigForRouteKey('PUT /x')).toEqual({ bodyType: 'json' });
		expect(discoveryConfigForRouteKey('PATCH /x')).toEqual({ bodyType: 'json' });
	});

	test('is tolerant of extra whitespace and case in the route key', () => {
		expect(discoveryConfigForRouteKey('post   /v1/private/topup')).toEqual({ bodyType: 'json' });
		expect(discoveryConfigForRouteKey('  get /v1/q/zec/height ')).toEqual({});
	});

	// The decoration logic mirrors registerX402: produce a bazaar
	// extension per route from the pure config. We assert the result is
	// shaped such that (a) the middleware will detect it and (b) it
	// validates once the HTTP method is enriched at settlement time —
	// exactly what bazaarResourceServerExtension does on the live path.
	test('every PREMIUM_ROUTES key yields a bazaar extension the middleware will catalogue', () => {
		const cfg = buildX402Config({ cfg: baseCfg(), env: {} });
		const routesWithDiscovery = {};
		for (const [key, routeCfg] of Object.entries(cfg.routes)) {
			routesWithDiscovery[key] = {
				...routeCfg,
				extensions: { ...declareDiscoveryExtension(discoveryConfigForRouteKey(key)) }
			};
		}
		expect(checkIfBazaarNeeded(routesWithDiscovery)).toBe(true);

		for (const [key, routeCfg] of Object.entries(routesWithDiscovery)) {
			const bazaar = routeCfg.extensions.bazaar;
			expect(bazaar).toBeDefined();
			// Enrich the method the way the runtime server extension does,
			// then it must pass the facilitator's schema validation.
			bazaar.info.input.method = key.split(' ', 1)[0];
			expect(validateDiscoveryExtension(bazaar)).toEqual({ valid: true });
		}
	});
});
