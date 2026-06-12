// x402 paywall wiring — Seneschal adapter over the embedded
// `payments-gateway` package (which itself wraps `x402-server-kit`).
//
// The generic engine — config validation, facilitator selection (CDP vs
// permissionless URL), @x402/fastify registration, Bazaar discovery and the
// paywall description — lives in x402-server-kit; the gateway package layers
// the privacy-payments route catalogue (Private Watch + privacy-chain facts)
// and price resolution on top. This module keeps only the Seneschal-specific
// pieces: the DeFi-liquidation + Ethereum-builder routes, and the combined
// PREMIUM_ROUTES catalogue that gates BOTH products behind one paywall.
//
// The data-api is free at the standard endpoints and gated at the
// Private-Watch + Penny-Oracle + premium-feed routes below.

import config from './config.js';
import {
	buildX402Config as gwBuildX402Config,
	createFacilitatorClient as gwCreateFacilitatorClient,
	registerX402 as gwRegisterX402,
	GATEWAY_PREMIUM_ROUTES,
	qFact,
	describePaywall,
	discoveryConfigForRouteKey,
	assertPrice,
	CDP_FACILITATOR_URL
} from 'payments-gateway';

// Re-export the pure helpers unchanged so existing importers
// (rest-server.js, tests) keep working.
export { describePaywall, discoveryConfigForRouteKey, assertPrice, CDP_FACILITATOR_URL };

// Premium endpoints we gate. Order is lead-product first: the gateway's
// Monero/Zcash view-key payment webhooks (Private Watch) and privacy-chain
// facts head the list — so the discovery doc, MCP surface and paywall
// description all present them first — with Seneschal's DeFi-liquidation
// and Ethereum-builder feeds after. The gateway entries come straight from
// the package so the two products can't drift.
export const PREMIUM_ROUTES = Object.freeze([
	// === Payments gateway: Private Watch + privacy-chain facts ===
	...GATEWAY_PREMIUM_ROUTES,

	// === DeFi liquidation + Ethereum builder feeds ===
	Object.freeze({
		method: 'GET',
		path: '/v1/premium/opportunities',
		description: 'Top at-risk borrowers across Aave + Morpho + Spark with realised market success-rate, average actual profit-USD, and the builder most likely to land each market. Sorted by expected EV. Pure SQL, no live RPC.',
		mimeType: 'application/json',
		priceEnvKey: 'X402_FEED_PRICE'
	}),
	Object.freeze({
		method: 'GET',
		path: '/v1/premium/builder-stats',
		description: 'Per-builder bid distribution (p25/median/p75/p90/p99/max) and hourly slot activity histogram from the Seneschal shadow recorder. Answers "what bid value do I need to land in builder X right now?" for searchers tuning bundle pricing.',
		mimeType: 'application/json',
		priceEnvKey: 'X402_BUILDER_STATS_PRICE'
	}),
	// === DeFi / builder atomic facts ===
	qFact('/v1/q/liquidatable',        'Single-fact: is borrower X currently liquidatable? Returns {found, liquidatable, hf, debt_usd, last_seen_ms} sourced from Aave + Morpho snapshots.'),
	qFact('/v1/q/at-risk-count',       'Single-fact: how many borrowers have HF < max_hf and debt >= min_debt_usd right now? Returns {count, total_debt_usd}.'),
	qFact('/v1/q/recent-liquidations', 'Single-fact: how many on-chain liquidations have we observed in the last `since_min` minutes, with what aggregate debt? Returns {count, total_debt_usd}.'),
	qFact('/v1/q/top-builder',         'Single-fact: which builder has the largest slot share in the named window (24h|7d|30d)? Returns {builder, share_pct, slots_won}.'),
	qFact('/v1/q/builder-share',       'Single-fact: what share of slots in the window did `builder` win? Substring match.'),
	qFact('/v1/q/builder-bid',         'Single-fact: percentile bid value (in ETH) for `builder` over the window. Returns {value_eth, samples}.'),
	qFact('/v1/q/cheapest-flashloan',  'Single-fact: cheapest flash-loan provider for `asset` on `chain` (default ethereum). Returns {provider, fee_bps, address}.'),
	qFact('/v1/q/data-freshness',      'Single-fact: age in seconds of the freshest record in the named source (shadow_blocks|borrower_snapshot|morpho_borrower_snapshot|missed_liquidations|executions).')
]);

/**
 * Validate operator-supplied x402 config and return the normalised view the
 * rest of the API relies on. Delegates price resolution (env var → cfg →
 * feed default) and route-table assembly to the gateway package, passing the
 * combined catalogue so one paywall covers both products.
 *
 * Returns `{ enabled: false, reason }` when the paywall is intentionally
 * off, or throws if env vars are present but malformed.
 */
export function buildX402Config({ cfg = config, env = process.env } = {}) {
	return gwBuildX402Config({ cfg, env, routes: PREMIUM_ROUTES });
}

/**
 * Build the facilitator client the paywall dispatches verify/settle to.
 * CDP creds are read from `cfg` at dispatch time by the gateway package.
 */
export async function createFacilitatorClient(x402Cfg, { cfg = config } = {}) {
	return gwCreateFacilitatorClient(x402Cfg, { cfg });
}

/**
 * Install the paywall on an existing Fastify app. Thin wrapper so
 * rest-server can keep calling `registerX402(app, x402Cfg)`.
 */
export async function registerX402(app, x402Cfg, { cfg = config } = {}) {
	return gwRegisterX402(app, x402Cfg, { cfg });
}
