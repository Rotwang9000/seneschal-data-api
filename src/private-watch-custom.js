// Variable-amount Private Watch credit top-ups.
//
// The @x402/fastify paywall registered in `x402.js` only handles
// FIXED-price routes — one entry per (METHOD, path) tuple, each
// pinned to a single dollar amount. That serves the three tier
// shortcuts (`/topup`, `/topup-1`, `/topup-5`) well, but it can't
// express "let the user pick any amount between $0.10 and $25".
//
// This module owns the dynamic-pricing variant:
//   - `POST /v1/private/topup-custom`  body: { watchId, watchToken,
//     amountAtomic }. Server reads the requested amount, generates
//     a matching x402 challenge, then on the retry hop verifies +
//     settles via the facilitator (sharing the same configuration
//     as the static plugin so prices, network, and recipient are
//     guaranteed consistent).
//
// Design rules followed:
//   * Pure helpers (validators, requirement builders, challenge
//     encoders) are exported so the unit tests don't need to spin
//     up Fastify or a facilitator stub.
//   * `registerCustomTopupRoute` is the only side-effecty bit and
//     it's kept tiny — easier to read, easier to migrate when the
//     @x402 toolchain catches up with dynamic pricing natively.
//   * The route bypasses @x402/fastify entirely. That means we
//     re-implement the verify+settle dance, but we reuse the
//     official `HTTPFacilitatorClient` so the wire protocol stays
//     spec-compliant.

import {
	WATCH_CONSTANTS,
	atomicToUsdString,
	buildCreditBlock,
	effectiveRatesForRow
} from './private-watch.js';
import { topupWatch as storeTopupWatch, getWatch as storeGetWatch } from './private-watch-store.js';

/**
 * Canonical USDC addresses per CAIP-2 network. Anything outside
 * this map causes the route to throw at boot — better to fail loud
 * than to ship a paywall that silently mints challenges with the
 * wrong asset address.
 */
const ASSET_BY_NETWORK = Object.freeze({
	'eip155:8453':  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base mainnet
	'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e'  // Base Sepolia (testnet)
});

/**
 * Hard limits on a single custom top-up. We deliberately cap the
 * upper bound below "house deposit" levels so a slider drag-by-
 * accident in the panel can't cost more than a coffee. Users who
 * actually want to bulk-fund a watch can issue multiple top-ups —
 * the credit meter is additive.
 */
export const CUSTOM_TOPUP_LIMITS = Object.freeze({
	MIN_ATOMIC: 100_000n,      // $0.10 — same as the cheapest tier
	MAX_ATOMIC: 25_000_000n    // $25.00
});

/**
 * Parse + validate the request body for `POST /v1/private/topup-
 * custom`. Throws `TypeError` with a human-readable message on bad
 * input. Returns the normalised shape — `amountAtomic` as a
 * `bigint` so downstream arithmetic stays exact.
 */
export function validateCustomTopupRequest(body) {
	if (!body || typeof body !== 'object') {
		throw new TypeError('request body must be a JSON object');
	}
	if (typeof body.watchId !== 'string' || !/^[0-9a-fA-F-]{36}$/u.test(body.watchId)) {
		throw new TypeError('watchId must be a UUID');
	}
	if (typeof body.watchToken !== 'string' || body.watchToken.length < 8) {
		throw new TypeError('watchToken must be a non-empty string');
	}
	const raw = body.amountAtomic;
	let atomic;
	if (typeof raw === 'string' && /^\d+$/u.test(raw)) {
		atomic = BigInt(raw);
	}
	else if (typeof raw === 'number' && Number.isFinite(raw) && Number.isInteger(raw) && raw > 0) {
		atomic = BigInt(raw);
	}
	else if (typeof raw === 'bigint') {
		atomic = raw;
	}
	else {
		throw new TypeError('amountAtomic must be a positive integer (atomic USDC, 6 decimals)');
	}
	if (atomic < CUSTOM_TOPUP_LIMITS.MIN_ATOMIC || atomic > CUSTOM_TOPUP_LIMITS.MAX_ATOMIC) {
		const min = atomicToUsdString(CUSTOM_TOPUP_LIMITS.MIN_ATOMIC);
		const max = atomicToUsdString(CUSTOM_TOPUP_LIMITS.MAX_ATOMIC);
		throw new TypeError(`amountAtomic out of range: must be between ${CUSTOM_TOPUP_LIMITS.MIN_ATOMIC} (${min}) and ${CUSTOM_TOPUP_LIMITS.MAX_ATOMIC} (${max})`);
	}
	return Object.freeze({
		watchId: body.watchId,
		watchToken: body.watchToken,
		amountAtomic: atomic
	});
}

/**
 * Build the x402 PaymentRequirements object for a given dynamic
 * amount. Shape matches what the facilitator and any x402 client
 * library expect when verifying / settling.
 */
export function buildCustomPaymentRequirements({ x402Cfg, amountAtomic }) {
	if (!x402Cfg?.enabled) {
		throw new Error('x402 paywall is not configured; cannot build payment requirements');
	}
	const asset = ASSET_BY_NETWORK[x402Cfg.network];
	if (!asset) {
		throw new Error(`No canonical USDC mapping for x402 network ${x402Cfg.network}`);
	}
	return {
		scheme: 'exact',
		network: x402Cfg.network,
		asset,
		amount: String(amountAtomic),
		payTo: x402Cfg.recipient,
		maxTimeoutSeconds: x402Cfg.maxTimeoutSeconds ?? 120,
		extra: { name: 'USD Coin', version: '2' }
	};
}

/**
 * Encode a base64 x402 challenge for the `payment-required`
 * header. Match the structure already emitted by @x402/fastify so
 * any spec-conformant client (including our own panel) can parse
 * it without special-casing.
 */
export function encodeChallenge({ resourceUrl, description, accepts }) {
	const challenge = {
		x402Version: 2,
		error: 'Payment required',
		resource: {
			url: resourceUrl,
			description,
			mimeType: 'application/json'
		},
		accepts: [accepts]
	};
	return Buffer.from(JSON.stringify(challenge)).toString('base64');
}

/**
 * Decode a base64 `x-payment` header into the parsed payload
 * object. Returns `null` if it can't be parsed — let the caller
 * decide whether that's a 400 or a 402.
 */
export function decodePaymentHeader(headerValue) {
	if (typeof headerValue !== 'string' || headerValue.length === 0) return null;
	try {
		const json = Buffer.from(headerValue, 'base64').toString('utf8');
		const parsed = JSON.parse(json);
		if (!parsed || typeof parsed !== 'object') return null;
		return parsed;
	}
	catch (_) {
		return null;
	}
}

/**
 * Lazy-loaded HTTPFacilitatorClient. The @x402 toolchain depends
 * on viem + a handful of other ESM modules that take ~250 ms to
 * pull in cold; only instantiate when the first dynamic-topup
 * request actually arrives. We cache the constructor (not the
 * instance) so the test suite can swap in a fake.
 *
 * Tests inject a fake via the `facilitatorFactory` argument to
 * `registerCustomTopupRoute`.
 */
async function defaultFacilitatorFactory(url) {
	const { HTTPFacilitatorClient } = await import('@x402/core/server');
	return new HTTPFacilitatorClient({ url });
}

/**
 * Install the dynamic-amount top-up route. Returns nothing; the
 * caller already has the Fastify `app`. Mirrors the registration
 * shape used elsewhere in rest-server.js (one helper per family
 * of routes).
 *
 * `deps`:
 *   - `watchDb`   — the SQLite handle, same one shared with the
 *                   static topup tiers.
 *   - `x402Cfg`   — output of `buildX402Config(...)` from x402.js.
 *   - `facilitatorFactory` — optional override for tests.
 *   - `requirePaywall` / `privateWatchReady` /
 *     `privateNotConfigured` — same gate helpers the static tiers
 *     use; kept as parameters so this module never imports them
 *     directly from rest-server.js (no circular imports, easier
 *     to test in isolation).
 *   - `log` — optional logger (defaults to no-op).
 */
export function registerCustomTopupRoute(app, deps) {
	const {
		watchDb,
		x402Cfg,
		facilitatorFactory = defaultFacilitatorFactory,
		requirePaywall,
		privateWatchReady,
		privateNotConfigured,
		log = { info: () => {}, warn: () => {}, error: () => {} }
	} = deps;

	// Hard-required deps (always present, even when the watch
	// subsystem is disabled — they're closure-scoped helpers from
	// rest-server.js). Soft deps (watchDb, x402Cfg) may be null
	// when private watch is disabled at boot; the handler checks
	// them on the request path and returns 503 instead of throwing
	// at registration time.
	if (!requirePaywall || !privateWatchReady || !privateNotConfigured) {
		throw new Error('registerCustomTopupRoute: missing helper deps');
	}

	// Cache the facilitator client across requests. The factory
	// itself is async so we just memoise the promise.
	let facilitatorP = null;
	function getFacilitator() {
		if (!x402Cfg.enabled) {
			throw new Error('x402 paywall disabled; cannot dispatch to facilitator');
		}
		if (!facilitatorP) {
			facilitatorP = Promise.resolve(facilitatorFactory(x402Cfg.facilitatorUrl));
		}
		return facilitatorP;
	}

	app.post('/v1/private/topup-custom', async (req, reply) => {
		if (requirePaywall(reply)) return;
		if (!privateWatchReady() || !watchDb || !x402Cfg) {
			return privateNotConfigured(reply);
		}

		let body;
		try { body = validateCustomTopupRequest(req.body || {}); }
		catch (err) {
			return reply.code(400).send({ error: { code: 'invalid_request', message: err?.message ?? String(err) } });
		}

		// Build the requirements once — used for the challenge AND
		// for the verify/settle step so a client that signs against
		// our challenge gets the same authoritative copy back.
		const requirements = buildCustomPaymentRequirements({ x402Cfg, amountAtomic: body.amountAtomic });
		const description = `Add ${atomicToUsdString(body.amountAtomic)} of credit (${body.amountAtomic} atomic USDC) to an existing Private Watch. Body: { watchId, watchToken, amountAtomic }. Range: ${CUSTOM_TOPUP_LIMITS.MIN_ATOMIC}-${CUSTOM_TOPUP_LIMITS.MAX_ATOMIC} atomic USDC.`;
		const resourceUrl = `${req.protocol}://${req.hostname}/v1/private/topup-custom`;
		const challenge = encodeChallenge({ resourceUrl, description, accepts: requirements });

		const xPayment = req.headers['x-payment'];
		if (!xPayment) {
			return reply
				.code(402)
				.header('payment-required', challenge)
				.send({});
		}

		const payload = decodePaymentHeader(xPayment);
		if (!payload) {
			return reply.code(400).send({ error: { code: 'invalid_payment_header', message: 'x-payment is not valid base64 JSON' } });
		}
		const sentValue = String(payload?.payload?.authorization?.value ?? '');
		if (sentValue !== String(body.amountAtomic)) {
			return reply.code(400).send({ error: { code: 'amount_mismatch', message: `x-payment authorization.value (${sentValue}) does not match requested amountAtomic (${body.amountAtomic})` } });
		}

		let facilitator;
		try { facilitator = await getFacilitator(); }
		catch (err) {
			log.error({ err: err?.message ?? String(err) }, 'topup-custom: facilitator init failed');
			return reply.code(503).send({ error: { code: 'facilitator_unavailable', message: 'payment facilitator could not be initialised' } });
		}

		let verifyResult;
		try { verifyResult = await facilitator.verify(payload, requirements); }
		catch (err) {
			log.warn({ err: err?.message ?? String(err) }, 'topup-custom: facilitator verify threw');
			return reply.code(502).send({ error: { code: 'verify_failed', message: err?.message ?? 'facilitator verify threw' } });
		}
		if (!verifyResult?.isValid) {
			return reply
				.code(402)
				.header('payment-required', challenge)
				.send({ error: { code: 'payment_verification_failed', message: verifyResult?.invalidReason ?? 'facilitator rejected signature' } });
		}

		let settleResult;
		try { settleResult = await facilitator.settle(payload, requirements); }
		catch (err) {
			log.warn({ err: err?.message ?? String(err) }, 'topup-custom: facilitator settle threw');
			return reply.code(502).send({ error: { code: 'settle_failed', message: err?.message ?? 'facilitator settle threw' } });
		}
		if (!settleResult?.success) {
			return reply
				.code(402)
				.header('payment-required', challenge)
				.send({ error: { code: 'payment_settle_failed', message: settleResult?.errorReason ?? 'facilitator settle did not succeed' } });
		}
		reply.header('x-payment-response', Buffer.from(JSON.stringify(settleResult)).toString('base64'));

		// Payment has settled on-chain. Apply the credit to the
		// watch row. If this fails, the user has paid but the
		// credit didn't land — log loudly so the operator can
		// reconcile manually. We deliberately don't try to refund
		// (the protocol can't) and return a 5xx so the client
		// knows something went wrong on our side.
		// Read the existing watch's locked-in rate so the top-up
		// honours the surge tier the user signed up at.
		const existing = storeGetWatch(watchDb, body.watchId, body.watchToken);
		const rates = existing && !existing.error
			? effectiveRatesForRow(existing)
			: {
				dayRateAtomic: WATCH_CONSTANTS.DAY_RATE_ATOMIC,
				lowCreditThresholdAtomic: WATCH_CONSTANTS.LOW_CREDIT_THRESHOLD_ATOMIC
			};
		const out = storeTopupWatch(watchDb, body.watchId, body.watchToken, {
			creditAtomic: Number(body.amountAtomic),
			dayRateAtomic: rates.dayRateAtomic,
			lowThresholdAtomic: rates.lowCreditThresholdAtomic,
			maxLifetimeMs: WATCH_CONSTANTS.MAX_WATCH_LIFETIME_MS
		});
		if (!out.ok) {
			log.error({
				watchId: body.watchId,
				reason: out.reason,
				amountAtomic: String(body.amountAtomic),
				settlement: settleResult
			}, 'topup-custom: payment captured but watch update failed');
			const code = out.reason === 'not_found' ? 404 : out.reason === 'forbidden' ? 403 : 409;
			return reply.code(code).send({
				error: {
					code: `${out.reason}_after_payment`,
					message: 'payment captured but watch update failed — contact the operator with the settlement payload',
					captured: { amountAtomic: String(body.amountAtomic), settlement: settleResult }
				}
			});
		}

		log.info({
			watchId: body.watchId,
			amountAtomic: String(body.amountAtomic),
			newBalanceAtomic: out.row.credit_atomic
		}, 'topup-custom: credit applied');

		return {
			watchId: out.row.id,
			tier: 'custom',
			creditAppliedAtomic: String(body.amountAtomic),
			credit: buildCreditBlock(out.row),
			expiresAt: new Date(out.row.expires_at_ms).toISOString()
		};
	});
}
