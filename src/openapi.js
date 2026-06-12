// OpenAPI 3.1 document builder for the public API.
//
// x402 indexers treat OpenAPI as the canonical discovery contract:
// x402scan refuses to register an origin without one, and grades each
// payable operation on (a) an `x-payment-info` block whose price agrees
// with the runtime 402 challenge, (b) a declared 402 response, and
// (c) a request schema for invocable routes. This module derives the
// document from the SAME route catalogue + resolved prices that drive
// the paywall (x402Cfg.routes), so the spec cannot drift from runtime
// behaviour — the failure mode the indexers exist to catch.
//
// Pure function: callers pass the resolved x402 config; nothing here
// touches env or network.

import { QUESTION_REGISTRY } from './queries-q.js';
import { CHAIN_QUESTION_REGISTRY } from 'payments-gateway';

const API_BASE_URL = 'https://api.seneschal.space';
const CONTACT_URL = 'https://t.me/OrknetP';
const DOCS_URL = 'https://docs.seneschal.space';

// Indexers want plain decimal USD amounts ("0.001"); the paywall config
// carries operator-friendly dollar strings ("$0.001").
export function priceToAmount(price) {
	const trimmed = String(price ?? '').trim();
	const amount = trimmed.startsWith('$') ? trimmed.slice(1) : trimmed;
	return amount;
}

// Query-parameter descriptors from the Penny-Oracle registries use
// 'name' / 'name?' strings; expand them into OpenAPI parameter objects.
export function inputsToParameters(inputs) {
	return (inputs ?? []).map((raw) => {
		const optional = raw.endsWith('?');
		const name = optional ? raw.slice(0, -1) : raw;
		return {
			name,
			in: 'query',
			required: !optional,
			schema: { type: 'string' }
		};
	});
}

// Hand-rolled request schemas for the POST routes. These mirror the
// zod validation in the gateway handlers; kept compact deliberately —
// agents need field names, types and required-ness, not every refine.
const WATCH_BODY_SCHEMA = {
	type: 'object',
	required: ['chain', 'address', 'viewKey', 'webhookUrl'],
	properties: {
		chain: { type: 'string', enum: ['monero', 'zcash'], description: 'Which chain the watched address lives on.' },
		address: { type: 'string', description: 'The receiving address to watch (Monero primary/subaddress, or Zcash unified/shielded address).' },
		viewKey: { type: 'string', description: 'Read-only view key: Monero private view key, or Zcash UFVK. A view key cannot spend funds.' },
		webhookUrl: { type: 'string', format: 'uri', description: 'HTTPS endpoint that receives an HMAC-signed POST for every inbound payment.' },
		birthdayHeight: { type: 'integer', description: 'Optional chain height to start scanning from (defaults to current tip).' }
	}
};

const TOPUP_BODY_SCHEMA = {
	type: 'object',
	required: ['watchId', 'watchToken'],
	properties: {
		watchId: { type: 'string', description: 'Watch identifier returned by POST /v1/private/watch.' },
		watchToken: { type: 'string', description: 'Bearer credential for the watch, returned at creation. Treat as a secret.' }
	}
};

const HISTORICAL_BODY_SCHEMA = {
	type: 'object',
	required: ['chain', 'viewKey'],
	properties: {
		chain: { type: 'string', enum: ['monero', 'zcash'] },
		address: { type: 'string', description: 'Required for Monero (address + view key pair); ignored for Zcash UFVK scans.' },
		viewKey: { type: 'string', description: 'Monero private view key or Zcash UFVK. Streamed to the scanner in memory only — never persisted.' },
		birthdayHeight: { type: 'integer', description: 'Scan start height (defaults to chain birthday for the key type).' },
		toHeight: { type: 'integer', description: 'Scan end height (defaults to tip).' },
		includeNotes: { type: 'boolean', description: 'Include the per-note breakdown in the response.' }
	}
};

const DERIVE_VIEWKEY_BODY_SCHEMA = {
	type: 'object',
	required: ['chain'],
	properties: {
		chain: { type: 'string', enum: ['zcash'], description: 'Currently Zcash only (UFVK derivation).' },
		seed: { type: 'string', description: 'BIP-39 mnemonic to derive from. Prefer running this derivation offline — see the docs link in the response.' },
		account: { type: 'integer', description: 'ZIP-32 account index (default 0).' }
	}
};

const REQUEST_BODY_SCHEMAS = Object.freeze({
	'POST /v1/private/watch': WATCH_BODY_SCHEMA,
	'POST /v1/private/topup': TOPUP_BODY_SCHEMA,
	'POST /v1/private/topup-1': TOPUP_BODY_SCHEMA,
	'POST /v1/private/topup-5': TOPUP_BODY_SCHEMA,
	'POST /v1/private/historical': HISTORICAL_BODY_SCHEMA
});

const X_GUIDANCE = [
	'Seneschal sells per-call data and payment-watching services over x402 (HTTP 402) USDC micropayments on Base — no account, no API key.',
	'Flow: GET any paid route → receive 402 + payment requirements → sign an EIP-3009 USDC authorisation for the quoted amount → retry with the X-PAYMENT header → get the data. Compatible clients (e.g. @x402/fetch) do this automatically.',
	'Products: (1) Private Watch — POST /v1/private/watch with a Monero/Zcash address + READ-ONLY view key + webhook URL; we run the nodes and POST you an HMAC-signed event for every inbound payment. Keep the returned watchToken + webhookSecret. Top up credit via POST /v1/private/topup{,-1,-5} or natively in XMR/ZEC (see /v1/private/info).',
	'(2) Penny Oracle — $0.001 single-fact GETs under /v1/q/* covering Monero/Zcash chain state and DeFi liquidation/builder data. Free catalogue at GET /v1/q.',
	'(3) Premium feeds — GET /v1/premium/opportunities (at-risk borrowers ranked by EV) and /v1/premium/builder-stats (builder bid distributions).',
	'Start free: GET /v1/q (catalogue), GET /v1/paywall (pricing + rails), GET /v1/private/info (product guide). MCP server with the same tools: https://mcp.seneschal.space.'
].join(' ');

/**
 * Build the OpenAPI 3.1 document. `x402Cfg` is the resolved paywall
 * config (buildX402Config output): `routes` maps "METHOD /path" to
 * entries whose `accepts.price` carries the runtime-true price.
 * When the paywall is disabled the paid routes are still listed (the
 * API itself answers 503 on them) but without x-payment-info, so the
 * document never advertises a price the runtime won't honour.
 */
export function buildOpenApiDocument({ x402Cfg, serviceVersion = '1.0.0' }) {
	const paths = {};

	// ── Paid routes, straight from the paywall catalogue ────────────
	for (const [routeKey, entry] of Object.entries(x402Cfg?.routes ?? {})) {
		const [method, path] = routeKey.split(' ');
		const lower = method.toLowerCase();
		const accepts = entry?.accepts ?? {};
		const operation = {
			operationId: routeKey.replace(/[^a-zA-Z0-9]+/gu, '_').replace(/^_+|_+$/gu, ''),
			summary: (accepts.description ?? '').split('.')[0] || path,
			description: accepts.description ?? '',
			responses: {
				200: { description: 'Paid response', content: { 'application/json': { schema: { type: 'object' } } } },
				402: { description: 'Payment Required' }
			},
			'x-payment-info': {
				price: { mode: 'fixed', currency: 'USD', amount: priceToAmount(accepts.price) },
				protocols: [{ x402: {} }]
			}
		};

		const bodySchema = REQUEST_BODY_SCHEMAS[routeKey];
		if (bodySchema) {
			operation.requestBody = {
				required: true,
				content: { 'application/json': { schema: bodySchema } }
			};
		}

		// Penny-Oracle GETs: query parameters from the registries.
		if (method === 'GET' && path.startsWith('/v1/q/')) {
			const name = path.slice('/v1/q/'.length);
			const meta = QUESTION_REGISTRY[name] ?? CHAIN_QUESTION_REGISTRY[name];
			const params = inputsToParameters(meta?.inputs);
			if (params.length > 0) operation.parameters = params;
		}

		paths[path] = { ...(paths[path] ?? {}), [lower]: operation };
	}

	// ── Free routes agents should start from ────────────────────────
	// `security: []` marks them auth-free so x402scan's prober knows
	// NOT to expect a 402 challenge from them (it otherwise refuses to
	// register routes that answer 200 unauthenticated).
	paths['/v1/q'] = {
		get: {
			operationId: 'GET_v1_q_catalogue',
			security: [],
			summary: 'Free catalogue of every Penny Oracle question',
			description: 'Lists every /v1/q/* single-fact route with its input parameters, the per-call price, and per-chain availability. No payment required.',
			responses: { 200: { description: 'Catalogue', content: { 'application/json': { schema: { type: 'object' } } } } }
		}
	};
	paths['/v1/paywall'] = {
		get: {
			operationId: 'GET_v1_paywall',
			security: [],
			summary: 'Free paywall metadata (prices, network, recipient)',
			description: 'Introspect x402 pricing and rails without making a paid call.',
			responses: { 200: { description: 'Paywall summary', content: { 'application/json': { schema: { type: 'object' } } } } }
		}
	};
	paths['/v1/private/info'] = {
		get: {
			operationId: 'GET_v1_private_info',
			security: [],
			summary: 'Free Private Watch product guide',
			description: 'Human- and agent-readable description of the Private Watch product: pricing, webhook signature scheme, top-up options (x402 + native XMR/ZEC), and the create/status/cancel lifecycle.',
			responses: { 200: { description: 'Product guide', content: { 'application/json': { schema: { type: 'object' } } } } }
		}
	};
	paths['/v1/private/derive-viewkey'] = {
		post: {
			operationId: 'POST_v1_private_derive_viewkey',
			security: [],
			summary: 'Free, rate-limited Zcash UFVK derivation',
			description: 'Derives a Zcash unified full viewing key from a seed phrase so it can be handed to POST /v1/private/watch. Prefer the offline derivation documented in the response; this endpoint exists for low-stakes convenience and is rate-limited per IP.',
			requestBody: { required: true, content: { 'application/json': { schema: DERIVE_VIEWKEY_BODY_SCHEMA } } },
			responses: { 200: { description: 'Derived view key', content: { 'application/json': { schema: { type: 'object' } } } } }
		}
	};

	return {
		openapi: '3.1.0',
		info: {
			title: 'Seneschal Data API',
			version: serviceVersion,
			description: 'Monero & Zcash payment watching for agents (view-key webhooks, historical scans, native XMR/ZEC top-ups) plus DeFi liquidation telemetry and Ethereum builder data. Paid per call via x402 USDC on Base — no account, no API key.',
			contact: { name: 'Seneschal', url: CONTACT_URL },
			'x-guidance': X_GUIDANCE
		},
		externalDocs: { description: 'Service docs', url: DOCS_URL },
		servers: [{ url: API_BASE_URL }],
		paths
	};
}
