#!/usr/bin/env node
// x402 self-bootstrap — settle a tiny real payment on our own paid
// endpoints so the facilitator catalogues them in its discovery index.
//
// Why this exists:
//   The x402 Bazaar (and Coinbase's Agentic.Market, the directory agents
//   actually search) only indexes an endpoint *after its first successful
//   settlement* — and only if the route declares the bazaar discovery
//   extension (ours do). That is a chicken-and-egg: no discovery without a
//   sale, no sale without discovery. We break it by making the first
//   payment ourselves.
//
//   The x402 `exact` / EIP-3009 scheme is gasless for the payer (the
//   facilitator broadcasts and pays gas), and the USDC moves from our
//   payer wallet to our own configured X402_RECIPIENT_ADDRESS — so the
//   bootstrap round-trips to ourselves and costs only the (tiny) network
//   settlement, not the sticker price.
//
//   As a bonus it is the definitive end-to-end test of the revenue rail:
//   if this settles, a real agent can pay us and we receive USDC; if it
//   fails, the failure reason (e.g. CDP auth) is exactly the bug blocking
//   all off-chain income.
//
// Usage (run from the repo root so --env-file picks up L2_PRIVATE_KEY):
//   node --env-file=.env services/data-api/scripts/x402-self-bootstrap.mjs            # dry-run
//   node --env-file=.env services/data-api/scripts/x402-self-bootstrap.mjs --pay      # settle (capped)
//   …  --pay --only xmr/height                  # bootstrap a single endpoint
//   …  --pay --max-usd 0.01                      # raise/lower the per-call spend cap
//   …  --pay --all-premium                       # also bootstrap the higher-priced premium feeds
//   …  --payments --pay --max-usd 0.12           # bootstrap the payments family: creates a real
//                                                  self-watch on our own XMR receive address
//                                                  (needs SENESCHAL_XMR_RECV_ADDRESS/_VIEW_KEY in
//                                                  env), then chains a topup on that watch
//
// Safety:
//   * Dry-run is the default; real settlement requires the explicit --pay flag.
//   * Refuses any endpoint whose quoted price exceeds --max-usd (default $0.005).
//   * The private key is read from env (L2_PRIVATE_KEY) and never logged.

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const USDC_DECIMALS = 6;
const DEFAULT_MAX_USD = 0.005;

const BASE_URL = (process.env.SENESCHAL_API_BASE || 'https://api.seneschal.space').replace(/\/$/, '');
const NETWORK = process.env.X402_NETWORK || 'eip155:8453';

// Cheapest real-data endpoints first ($0.001 each). These are the highest
// signal-to-cost targets to seed discovery with: privacy-chain facts are
// the differentiated product, the DeFi facts prove the liquidation data.
const PENNY_TARGETS = [
	// Privacy-chain facts — the differentiated product (operator-run XMR/ZEC
	// full nodes). Listed first so they seed discovery ahead of the
	// commodity DeFi facts.
	{ method: 'GET', path: '/v1/q/xmr/height' },
	{ method: 'GET', path: '/v1/q/xmr/mempool' },
	{ method: 'GET', path: '/v1/q/xmr/fee' },
	{ method: 'GET', path: '/v1/q/xmr/last-block' },
	{ method: 'GET', path: '/v1/q/zec/height' },
	{ method: 'GET', path: '/v1/q/zec/mempool' },
	{ method: 'GET', path: '/v1/q/zec/last-block' },
	// DeFi facts — parameterless ones first, then the parameterised ones
	// with cheap representative arguments (any valid query works; the
	// point is the settle, which is what triggers Bazaar indexing).
	{ method: 'GET', path: '/v1/q/at-risk-count' },
	{ method: 'GET', path: '/v1/q/recent-liquidations' },
	{ method: 'GET', path: '/v1/q/top-builder' },
	{ method: 'GET', path: '/v1/q/liquidatable?addr=0x0000000000000000000000000000000000000001' },
	{ method: 'GET', path: '/v1/q/builder-share?builder=titan' },
	{ method: 'GET', path: '/v1/q/builder-bid?builder=titan&pct=50' },
	{ method: 'GET', path: '/v1/q/cheapest-flashloan?asset=WETH' },
	{ method: 'GET', path: '/v1/q/data-freshness?source=borrower_snapshot' }
];

// Higher-priced premium feeds — only bootstrapped with --all-premium and a
// raised --max-usd, since each is $0.05-$0.10.
const PREMIUM_TARGETS = [
	{ method: 'GET', path: '/v1/premium/builder-stats' },
	{ method: 'GET', path: '/v1/premium/opportunities' }
];

// The payments product family (--payments). Creating a watch needs a real
// chain address + view key; we use our OWN XMR receive pair (from env, never
// hardcoded) so the bootstrap doubles as a live self-watch. The topup target
// is chained automatically from the watch-creation response (needs the fresh
// watchId + watchToken), so it is not listed here.
export function buildPaymentsTargets(env) {
	const address = env.SENESCHAL_XMR_RECV_ADDRESS;
	const viewKey = env.SENESCHAL_XMR_RECV_VIEW_KEY;
	assert(address && viewKey,
		'--payments needs SENESCHAL_XMR_RECV_ADDRESS + SENESCHAL_XMR_RECV_VIEW_KEY in env (see fin4 /etc/seneschal/data-api.env)');
	const webhookUrl = env.BOOTSTRAP_WEBHOOK_URL || `${BASE_URL}/v1/q`;
	return [{
		method: 'POST',
		path: '/v1/private/watch',
		body: {
			chain: 'monero',
			address,
			viewKey,
			webhookUrl,
			...(env.SENESCHAL_XMR_RECV_FROM_HEIGHT ? { birthdayHeight: Number(env.SENESCHAL_XMR_RECV_FROM_HEIGHT) } : {})
		},
		// After the watch settles, immediately bootstrap the topup route
		// against the watch we just created.
		chain: (resBody) => (resBody?.watchId && resBody?.watchToken ? {
			method: 'POST',
			path: '/v1/private/topup',
			body: { watchId: resBody.watchId, watchToken: resBody.watchToken }
		} : null)
	}];
}

export function parseArgs(argv) {
	const args = argv.slice(2);
	const has = (flag) => args.includes(flag);
	const val = (flag, fallback) => {
		const i = args.indexOf(flag);
		return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
	};
	return {
		pay: has('--pay'),
		allPremium: has('--all-premium'),
		payments: has('--payments'),
		only: val('--only', null),
		maxUsd: Number(val('--max-usd', String(DEFAULT_MAX_USD)))
	};
}

export function decodeChallengeHeader(headerVal) {
	if (!headerVal) return null;
	try {
		return JSON.parse(Buffer.from(headerVal, 'base64').toString('utf8'));
	} catch {
		return null;
	}
}

export function pickAccept(challenge, network) {
	const accepts = Array.isArray(challenge?.accepts) ? challenge.accepts : [];
	return accepts.find((a) => a?.network === network) ?? accepts[0] ?? null;
}

export function acceptAmountAtomic(accept) {
	const raw = accept?.amount ?? accept?.maxAmountRequired;
	return raw != null ? BigInt(raw) : null;
}

export function atomicToUsd(atomic) {
	return Number(atomic) / 10 ** USDC_DECIMALS;
}

function log(line) {
	process.stdout.write(line + '\n');
}

// Watch-creation responses carry credentials (watchToken, webhookSecret).
// They round-trip to ourselves here, but ops logs should not retain them.
export function redactSecrets(text) {
	return String(text).replace(/"(watchToken|webhookSecret|viewKey)":"[^"]*"/gu, '"$1":"<redacted>"');
}

export function requestInit(target) {
	const init = { method: target.method };
	if (target.body !== undefined) {
		init.headers = { 'content-type': 'application/json' };
		init.body = JSON.stringify(target.body);
	}
	return init;
}

async function probeChallenge(target) {
	const url = BASE_URL + target.path;
	const res = await fetch(url, requestInit(target));
	const challenge = decodeChallengeHeader(res.headers.get('payment-required'));
	return { url, status: res.status, challenge };
}

export function decodeSettlement(headerVal) {
	// `decodePaymentResponseHeader` throws on null/garbage, which happens
	// whenever the server did NOT settle (e.g. the resource 502'd before
	// the charge). Treat absence as "no settlement" rather than crashing.
	if (!headerVal) return null;
	try {
		return decodePaymentResponseHeader(headerVal);
	} catch {
		return null;
	}
}

async function settle(fetchWithPayment, target) {
	const url = BASE_URL + target.path;
	const startedMs = Date.now();
	const res = await fetchWithPayment(url, requestInit(target));
	const elapsedMs = Date.now() - startedMs;
	const settlement = decodeSettlement(res.headers.get('x-payment-response'));
	let bodyPreview = '';
	let resBody = null;
	if (res.ok) {
		resBody = await res.json().catch(() => null);
		bodyPreview = JSON.stringify(resBody).slice(0, 240);
	} else {
		bodyPreview = (await res.text().catch(() => '')).slice(0, 320);
	}
	return { status: res.status, ok: res.ok, elapsedMs, settlement, bodyPreview, resBody };
}

async function main() {
	const opts = parseArgs(process.argv);
	assert(Number.isFinite(opts.maxUsd) && opts.maxUsd > 0, '--max-usd must be a positive number');

	const pk = process.env.L2_PRIVATE_KEY;
	assert(pk, 'L2_PRIVATE_KEY not set — run from repo root with `node --env-file=.env …`');
	const account = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);

	let targets = [
		...(opts.payments ? buildPaymentsTargets(process.env) : PENNY_TARGETS),
		...(opts.allPremium ? PREMIUM_TARGETS : [])
	];
	if (opts.only) targets = targets.filter((t) => t.path.includes(opts.only));
	assert(targets.length > 0, `no targets match --only ${opts.only}`);

	log(`payer:   ${account.address}`);
	log(`base:    ${BASE_URL}`);
	log(`network: ${NETWORK}`);
	log(`mode:    ${opts.pay ? 'PAY (real settlement)' : 'DRY-RUN (no payment)'}   per-call cap: $${opts.maxUsd}`);

	const fetchWithPayment = opts.pay
		? wrapFetchWithPaymentFromConfig(fetch, {
			schemes: [{ network: NETWORK, client: new ExactEvmScheme(account) }]
		})
		: null;

	let settledOk = 0;
	let settledFail = 0;

	// Queue (not a plain for-of) so a settled target can append a chained
	// follow-up — e.g. watch creation enqueues the topup for that watch.
	const queue = [...targets];
	while (queue.length > 0) {
		const target = queue.shift();
		log('');
		log(`${target.method} ${target.path}`);
		const { status, challenge } = await probeChallenge(target);
		const accept = pickAccept(challenge, NETWORK);
		const atomic = acceptAmountAtomic(accept);
		const usd = atomic != null ? atomicToUsd(atomic) : null;
		log(`  challenge: http=${status} price=${usd != null ? `$${usd}` : '?'} payTo=${accept?.payTo ?? '?'} net=${accept?.network ?? '?'}`);
		log(`  resource=${challenge?.resource?.url ?? '?'} bazaarExt=${challenge?.extensions?.bazaar ? 'yes' : 'NO'}`);

		if (!opts.pay) continue;

		if (usd == null) {
			log('  SKIP: no price in challenge (endpoint may be free or not paywalled)');
			continue;
		}
		if (usd > opts.maxUsd) {
			log(`  SKIP: price $${usd} exceeds cap $${opts.maxUsd} (raise with --max-usd to bootstrap this one)`);
			continue;
		}

		try {
			const { status: payStatus, ok: httpOk, elapsedMs, settlement, bodyPreview, resBody } = await settle(fetchWithPayment, target);
			const ok = httpOk && settlement?.success !== false;
			if (ok) settledOk += 1; else settledFail += 1;
			const tx = settlement?.transaction ?? settlement?.txHash ?? settlement?.transactionHash ?? '?';
			log(`  ${ok ? 'SETTLED' : 'FAILED '}: http=${payStatus} in ${elapsedMs}ms success=${settlement?.success} tx=${tx}`);
			log(`  settlement: ${JSON.stringify(settlement ?? {}).slice(0, 240)}`);
			log(`  body: ${redactSecrets(bodyPreview)}`);
			if (ok && typeof target.chain === 'function') {
				const next = target.chain(resBody);
				if (next) {
					log(`  chained -> ${next.method} ${next.path}`);
					queue.push(next);
				} else {
					log('  chained -> (response missing fields; follow-up skipped)');
				}
			}
		} catch (err) {
			settledFail += 1;
			log(`  FAILED : ${err?.message ?? String(err)}`);
		}
	}

	if (opts.pay) {
		log('');
		log(`done: settled=${settledOk} failed=${settledFail}`);
		// Non-zero exit if every paid attempt failed, so an operator/CI run
		// surfaces a broken rail rather than a silent no-op.
		if (settledOk === 0 && settledFail > 0) process.exit(2);
	}
}

// Only auto-run when invoked directly (CLI / npm script), NOT when the
// test suite imports the exported helpers.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	main().catch((err) => {
		process.stderr.write(`FATAL ${err?.message ?? String(err)}\n`);
		process.exit(1);
	});
}
