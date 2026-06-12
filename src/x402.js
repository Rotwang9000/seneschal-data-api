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
// Query-input schema fragments for the DeFi facts. Plain JSON schema —
// they feed the Bazaar discovery extension so indexers can probe and
// agents can invoke without reading prose. Names mirror QUESTION_REGISTRY.
const QI = Object.freeze({
	protocol: { type: 'string', description: 'Optional protocol filter (aave|morpho|spark|compound).' },
	window: { type: 'string', description: 'Lookback window: 24h, 7d or 30d (default 24h).' },
	builder: { type: 'string', description: 'Builder name (substring match).' }
});

export const PREMIUM_ROUTES = Object.freeze([
	// === Payments gateway: Private Watch + privacy-chain facts ===
	...GATEWAY_PREMIUM_ROUTES,

	// === DeFi liquidation + Ethereum builder feeds ===
	Object.freeze({
		method: 'GET',
		path: '/v1/premium/opportunities',
		description: 'Top at-risk borrowers across Aave + Morpho + Spark with realised market success-rate, average actual profit-USD, and the builder most likely to land each market. Sorted by expected EV. Pure SQL, no live RPC.',
		mimeType: 'application/json',
		priceEnvKey: 'X402_FEED_PRICE',
		discovery: Object.freeze({
			output: {
				example: { as_of_ms: 1765532000000, opportunities: [{ addr: '0x1234…', protocol: 'aave', hf: 0.98, debt_usd: 125000, expected_value_usd: 310.5, likely_builder: 'titan' }] },
				schema: { type: 'object', properties: { as_of_ms: { type: 'integer' }, opportunities: { type: 'array', items: { type: 'object' } } }, additionalProperties: true }
			}
		})
	}),
	Object.freeze({
		method: 'GET',
		path: '/v1/premium/builder-stats',
		description: 'Per-builder bid distribution (p25/median/p75/p90/p99/max) and hourly slot activity histogram from the Seneschal shadow recorder. Answers "what bid value do I need to land in builder X right now?" for searchers tuning bundle pricing.',
		mimeType: 'application/json',
		priceEnvKey: 'X402_BUILDER_STATS_PRICE',
		discovery: Object.freeze({
			output: {
				example: { as_of_ms: 1765532000000, builders: [{ builder: 'titan', slots_won: 412, share_pct: 28.6, bid_eth: { p25: 0.012, median: 0.031, p90: 0.22, max: 1.9 } }] },
				schema: { type: 'object', properties: { as_of_ms: { type: 'integer' }, builders: { type: 'array', items: { type: 'object' } } }, additionalProperties: true }
			}
		})
	}),
	// === DeFi / builder atomic facts ===
	// Output schemas list the headline fields (handlers may add more —
	// additionalProperties stays open by JSON-schema default).
	qFact('/v1/q/liquidatable',        'Single-fact: is borrower X currently liquidatable? Returns {found, liquidatable, hf, debt_usd, last_seen_ms} sourced from Aave + Morpho snapshots.', {
		inputSchema: { type: 'object', required: ['addr'], properties: { addr: { type: 'string', description: 'Borrower address (0x…).' }, protocol: QI.protocol } },
		inputExample: { addr: '0x1234567890abcdef1234567890abcdef12345678' },
		outputProps: { found: { type: 'boolean' }, addr: { type: 'string' }, liquidatable: { type: 'boolean' }, hf: { type: 'number' }, debt_usd: { type: 'number' }, last_seen_ms: { type: 'integer' } },
		outputExample: { found: true, addr: '0x1234567890abcdef1234567890abcdef12345678', liquidatable: false, hf: 1.42, debt_usd: 52000, last_seen_ms: 1765532000000 }
	}),
	qFact('/v1/q/at-risk-count',       'Single-fact: how many borrowers have HF < max_hf and debt >= min_debt_usd right now? Returns {count, total_debt_usd}.', {
		inputSchema: { type: 'object', properties: { max_hf: { type: 'string', description: 'Health-factor ceiling (default 1.05).' }, min_debt_usd: { type: 'string', description: 'Minimum debt in USD (default 0).' }, protocol: QI.protocol } },
		inputExample: { max_hf: '1.05', min_debt_usd: '1000' },
		outputProps: { count: { type: 'integer' }, total_debt_usd: { type: 'number' } },
		outputExample: { count: 14, total_debt_usd: 1825000 }
	}),
	qFact('/v1/q/recent-liquidations', 'Single-fact: how many on-chain liquidations have we observed in the last `since_min` minutes, with what aggregate debt? Returns {count, total_debt_usd}.', {
		inputSchema: { type: 'object', properties: { since_min: { type: 'string', description: 'Lookback in minutes (default 60).' }, protocol: QI.protocol } },
		inputExample: { since_min: '60' },
		outputProps: { count: { type: 'integer' }, total_debt_usd: { type: 'number' } },
		outputExample: { count: 3, total_debt_usd: 96000 }
	}),
	qFact('/v1/q/top-builder',         'Single-fact: which builder has the largest slot share in the named window (24h|7d|30d)? Returns {builder, share_pct, slots_won}.', {
		inputSchema: { type: 'object', properties: { window: QI.window } },
		inputExample: { window: '24h' },
		outputProps: { as_of_ms: { type: 'integer' }, window: { type: 'string' }, builder: { type: 'string' }, share_pct: { type: 'number' }, slots_won: { type: 'integer' }, total_slots: { type: 'integer' } },
		outputExample: { as_of_ms: 1765532000000, window: '24h', builder: 'titan', share_pct: 28.6, slots_won: 412, total_slots: 1440 }
	}),
	qFact('/v1/q/builder-share',       'Single-fact: what share of slots in the window did `builder` win? Substring match.', {
		inputSchema: { type: 'object', required: ['builder'], properties: { builder: QI.builder, window: QI.window } },
		inputExample: { builder: 'titan', window: '24h' },
		outputProps: { as_of_ms: { type: 'integer' }, window: { type: 'string' }, builder: { type: 'string' }, share_pct: { type: 'number' }, slots_won: { type: 'integer' }, total_slots: { type: 'integer' } },
		outputExample: { as_of_ms: 1765532000000, window: '24h', builder: 'titan', share_pct: 28.6, slots_won: 412, total_slots: 1440 }
	}),
	qFact('/v1/q/builder-bid',         'Single-fact: percentile bid value (in ETH) for `builder` over the window. Returns {value_eth, samples}.', {
		inputSchema: { type: 'object', required: ['builder'], properties: { builder: QI.builder, pct: { type: 'string', description: 'Percentile 0-100 (default 50).' }, window: QI.window } },
		inputExample: { builder: 'titan', pct: '90', window: '24h' },
		outputProps: { value_eth: { type: 'number' }, samples: { type: 'integer' } },
		outputExample: { value_eth: 0.22, samples: 412 }
	}),
	qFact('/v1/q/cheapest-flashloan',  'Single-fact: cheapest flash-loan provider for `asset` on `chain` (default ethereum). Returns {provider, fee_bps, address}.', {
		inputSchema: { type: 'object', required: ['asset'], properties: { asset: { type: 'string', description: 'Asset symbol, e.g. WETH, USDC.' }, chain: { type: 'string', description: 'Chain name (default ethereum).' } } },
		inputExample: { asset: 'WETH' },
		outputProps: { found: { type: 'boolean' }, asset: { type: 'string' }, chain: { type: 'string' }, provider: { type: 'string' }, fee_bps: { type: 'number' }, address: { type: 'string' } },
		outputExample: { found: true, asset: 'WETH', chain: 'ethereum', provider: 'morpho-blue', fee_bps: 0, address: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' }
	}),
	qFact('/v1/q/data-freshness',      'Single-fact: age in seconds of the freshest record in the named source (shadow_blocks|borrower_snapshot|morpho_borrower_snapshot|missed_liquidations|executions).', {
		inputSchema: { type: 'object', required: ['source'], properties: { source: { type: 'string', description: 'One of shadow_blocks|borrower_snapshot|morpho_borrower_snapshot|missed_liquidations|executions.' } } },
		inputExample: { source: 'borrower_snapshot' },
		outputProps: { source: { type: 'string' }, age_s: { type: 'number' }, mtime_ms: { type: 'integer' } },
		outputExample: { source: 'borrower_snapshot', age_s: 42.5, mtime_ms: 1765531957500 }
	})
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
