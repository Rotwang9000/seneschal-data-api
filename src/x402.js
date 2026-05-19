// x402 paywall wiring.
//
// The data-api is free at the standard endpoints and gated at the
// `/v1/premium/*` family. Gating uses the x402 protocol from
// docs.x402.org/core-concepts/http-402: an unpaid request gets HTTP 402
// + a PAYMENT-REQUIRED header carrying signed PaymentRequirements; the
// client retries with a PAYMENT-SIGNATURE header carrying an
// EIP-3009 transferWithAuthorization signature, and we delegate
// verification + settlement to a facilitator service.
//
// We deliberately keep this module thin and free of side effects so
// the rest of the API still boots when `X402_RECIPIENT_ADDRESS` is
// unset. In that mode the premium routes answer 503 "premium tier
// not configured" rather than mysteriously 402-ing without a real
// recipient.
//
// The heavy lifting is done by `@x402/fastify`: route matching,
// payload encoding/decoding, facilitator dispatch, settlement-header
// emission. We supply nothing more than configuration.

import config from './config.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u;

// Premium endpoints we'll wire up. Keep this in one place so the
// systemd unit, the README, and the MCP tool descriptions all stay in
// sync — touch one constant, the rest follow.
export const PREMIUM_ROUTES = Object.freeze([
	Object.freeze({
		method: 'GET',
		path: '/v1/premium/opportunities',
		// Single source of truth for what the route returns and how
		// much it costs. The dashboard / docs / MCP tool can all
		// derive their copy from here.
		description: 'Top at-risk borrowers across Aave + Morpho + Spark with realised market success-rate, average actual profit-USD, and the builder most likely to land each market. Sorted by expected EV. Pure SQL, no live RPC.',
		mimeType: 'application/json',
		priceEnvKey: 'X402_FEED_PRICE'
	})
]);

/**
 * Validate operator-supplied x402 config and return the normalised view
 * the rest of the module relies on. Centralising the checks lets us
 * fail fast at boot — the worst possible outcome is a paywall that
 * accepts payments but never delivers, so we shake the wires early.
 *
 * Returns `{ enabled: false, reason }` when the paywall is intentionally
 * off, or throws if env vars are present but malformed (e.g. a non-hex
 * payTo address — that's a bug, not a config choice).
 */
export function buildX402Config({ cfg = config, env = process.env } = {}) {
	const recipient = (cfg.x402RecipientAddress || '').trim();
	const enabled = cfg.x402Enabled || Boolean(recipient);
	if (!enabled) {
		return Object.freeze({
			enabled: false,
			reason: 'X402_RECIPIENT_ADDRESS not set'
		});
	}
	if (!ADDRESS_RE.test(recipient)) {
		throw new TypeError(`x402: X402_RECIPIENT_ADDRESS=${recipient} is not a 0x-prefixed 20-byte hex string`);
	}
	const network = (cfg.x402Network || 'eip155:8453').trim();
	if (!/^eip155:\d+$/u.test(network)) {
		throw new TypeError(`x402: X402_NETWORK=${network} must be a CAIP-2 identifier such as 'eip155:8453'`);
	}
	const facilitatorUrl = (cfg.x402FacilitatorUrl || '').trim();
	if (!facilitatorUrl || !/^https?:\/\//u.test(facilitatorUrl)) {
		throw new TypeError(`x402: X402_FACILITATOR_URL=${facilitatorUrl} must be an http(s) URL`);
	}
	// Build the per-route table the @x402/fastify middleware wants.
	// Pattern is `"<METHOD> <path>"` per the package docs.
	const routes = {};
	for (const r of PREMIUM_ROUTES) {
		const price = (env[r.priceEnvKey] || cfg[envKeyToCfg(r.priceEnvKey)] || cfg.x402FeedPrice || '$0.05').trim();
		assertPrice(price, r.priceEnvKey);
		routes[`${r.method} ${r.path}`] = {
			accepts: {
				scheme: 'exact',
				network,
				price,
				payTo: recipient,
				maxTimeoutSeconds: cfg.x402MaxTimeoutSeconds ?? 120
			},
			description: r.description,
			mimeType: r.mimeType
		};
	}
	return Object.freeze({
		enabled: true,
		recipient,
		network,
		facilitatorUrl,
		routes,
		// Keep the raw route descriptors handy for docs / MCP surfaces.
		premiumRoutes: PREMIUM_ROUTES
	});
}

function envKeyToCfg(envKey) {
	// X402_FEED_PRICE -> x402FeedPrice (camelCase). Lets the legacy
	// `cfg` field win if the operator pinned it that way.
	const parts = envKey.toLowerCase().split('_');
	return parts.map((p, i) => i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

function assertPrice(price, name) {
	// Accept either Money strings ("$0.05") or atomic-unit strings
	// ("50000" = 0.05 USDC at 6 decimals). The facilitator handles
	// both; this is a cheap sanity check so we don't ship a price
	// that's secretly NaN.
	if (typeof price !== 'string' || price.length === 0) {
		throw new TypeError(`x402: ${name} is not a non-empty string (got ${price})`);
	}
	const money = /^\$\d+(\.\d+)?$/u.test(price);
	const atomic = /^\d+$/u.test(price);
	if (!money && !atomic) {
		throw new TypeError(`x402: ${name}=${price} must be "$<dollars>" or a positive atomic-unit integer`);
	}
}

/**
 * Side-effecty bit: install the paywall on an existing Fastify app.
 * We isolate the dynamic `await import(...)` here so unit tests of the
 * config layer don't have to pay the cost of loading 1000+ wagmi
 * transitive deps. Production hot-path imports them once on boot and
 * never again.
 */
export async function registerX402(app, x402Cfg) {
	if (!x402Cfg.enabled) {
		throw new Error(`x402.registerX402: paywall disabled (${x402Cfg.reason ?? 'unknown'})`);
	}
	// Note: paywall HTML support is left intentionally off — the data
	// API is for headless agents, not browsers. If a human hits a
	// premium URL in their browser we'd rather they see the structured
	// 402 JSON than an opinionated wallet-connect dialog they can't
	// use anyway.
	const [{ paymentMiddlewareFromConfig }, { HTTPFacilitatorClient }, { ExactEvmScheme }] = await Promise.all([
		import('@x402/fastify'),
		import('@x402/core/server'),
		import('@x402/evm/exact/server')
	]);
	const facilitatorClient = new HTTPFacilitatorClient({ url: x402Cfg.facilitatorUrl });
	const schemes = [{ network: x402Cfg.network, server: new ExactEvmScheme() }];
	paymentMiddlewareFromConfig(
		app,
		x402Cfg.routes,
		facilitatorClient,
		schemes,
		/* paywallConfig */ undefined,
		/* paywall */ undefined,
		/* syncFacilitatorOnStart */ false
	);
}

/**
 * Public-facing description of the paywall, exposed by `/` and the
 * MCP tool surface so agents can introspect cost + payment rails
 * without having to make a 402-receiving request first. Returns
 * `null` when the paywall is off, so callers can hide the section.
 */
export function describePaywall(x402Cfg) {
	if (!x402Cfg?.enabled) return null;
	const routes = Object.entries(x402Cfg.routes).map(([key, value]) => ({
		endpoint: key,
		price: value.accepts.price,
		description: value.description,
		mime_type: value.mimeType
	}));
	return {
		protocol: 'x402',
		spec: 'https://docs.x402.org',
		network: x402Cfg.network,
		facilitator: x402Cfg.facilitatorUrl,
		payTo: x402Cfg.recipient,
		scheme: 'exact (EIP-3009 transferWithAuthorization)',
		asset_note: 'Network resolves the canonical USDC contract; clients should consult the facilitator /supported endpoint for the address.',
		routes
	};
}
