#!/usr/bin/env node
// Privacy-coin receive-poller driver.
//
// On each run it scans OUR receiving wallet(s) through NFPT, matches
// incoming Monero/Zcash payments to open top-up quotes, counts
// confirmations, and credits the matching watch at the quote's locked
// rate. Designed to be driven by a systemd .timer every ~60s.
//
// We hold ONLY the receiving wallet's view key — never the spend key —
// so this process can see payments but can never move funds. That's the
// same no-custody posture the product sells.
//
// Configuration is via env, mirroring the REST server. A chain is only
// polled when BOTH its receive address and view key are set:
//   SENESCHAL_XMR_RECV_ADDRESS + SENESCHAL_XMR_RECV_VIEW_KEY
//   SENESCHAL_ZEC_RECV_ADDRESS + SENESCHAL_ZEC_RECV_UFVK
// Optional: SENESCHAL_ZEC_RECV_BIRTHDAY_HEIGHT, SENESCHAL_XMR_RECV_FROM_HEIGHT,
//           CRYPTO_TOPUP_XMR_CONFIRMATIONS, CRYPTO_TOPUP_ZEC_CONFIRMATIONS,
//           PRIVATE_WATCH_DB, NFPT_BASE_URL, NFPT_API_KEY.

import config from '../src/config.js';
import { openWatchDb } from '../src/private-watch-store.js';
import { ensureCryptoTopupSchema } from '../src/crypto-topup-store.js';
import { createNfptClient, scanReceiving } from '../src/private-watch-nfpt.js';
import { runCryptoRecvTick, makeWatchCreditApplier } from '../src/crypto-recv-poller.js';

// NU6 activation height — a safe default Zcash birthday so an
// unconfigured birthday never triggers a multi-hour autoDetect walk.
const ZEC_NU6_BIRTHDAY = 3_042_000;

// Poll NFPT scan-job status every 4 s rather than the 1.5 s library default.
// This poller only runs every ~60 s, so sub-second granularity buys nothing,
// and the slower cadence keeps two chains' continuous polling comfortably
// under NFPT's per-IP job-status budget (was exhausting it → HTTP 429).
const NFPT_POLL_INTERVAL_MS = 4_000;

function logJson(level, obj) {
	process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, ...obj })}\n`);
}

function configuredChains() {
	const chains = [];
	if (config.xmrRecvAddress && config.xmrRecvViewKey) chains.push('monero');
	if (config.zecRecvAddress && config.zecRecvUfvk) chains.push('zcash');
	return chains;
}

function makeScan(nfptClient) {
	return async (chain) => {
		if (chain === 'monero') {
			return scanReceiving(nfptClient, {
				chain: 'monero',
				address: config.xmrRecvAddress,
				viewKey: config.xmrRecvViewKey,
				fromHeight: config.xmrRecvFromHeight > 0 ? config.xmrRecvFromHeight : undefined,
				pollIntervalMs: NFPT_POLL_INTERVAL_MS
			});
		}
		return scanReceiving(nfptClient, {
			chain: 'zcash',
			address: config.zecRecvAddress,
			viewKey: config.zecRecvUfvk,
			birthdayHeight: config.zecRecvBirthdayHeight > 0 ? config.zecRecvBirthdayHeight : ZEC_NU6_BIRTHDAY,
			pollIntervalMs: NFPT_POLL_INTERVAL_MS
		});
	};
}

async function main() {
	const chains = configuredChains();
	if (chains.length === 0) {
		logJson('info', { event: 'crypto_recv_poller_skipped', reason: 'no XMR/ZEC receiving wallet configured' });
		process.exit(0);
	}
	const db = openWatchDb(config.privateWatchDbPath);
	ensureCryptoTopupSchema(db);
	const nfptClient = createNfptClient({
		baseUrl: config.nfptBaseUrl,
		apiKey: config.nfptApiKey,
		timeoutMs: config.nfptTimeoutMs,
		fetchImpl: globalThis.fetch
	});
	const logger = {
		info: (obj, msg) => logJson('info', { msg, ...flatten(obj) }),
		warn: (obj, msg) => logJson('warn', { msg, ...flatten(obj) }),
		error: (obj, msg) => logJson('error', { msg, ...flatten(obj) })
	};
	try {
		const summary = await runCryptoRecvTick({
			db,
			chains,
			scan: makeScan(nfptClient),
			applyCredit: makeWatchCreditApplier(db),
			confirmations: {
				monero: config.cryptoTopupXmrConfirmations,
				zcash: config.cryptoTopupZecConfirmations
			},
			logger
		});
		logJson('info', { event: 'crypto_recv_tick', chains, ...summary });
		process.exit(0);
	}
	catch (err) {
		logJson('error', { event: 'crypto_recv_tick_failed', message: err?.message ?? String(err), stack: err?.stack });
		process.exit(2);
	}
}

function flatten(obj) {
	if (!obj || typeof obj !== 'object') return {};
	return obj;
}

main().catch((err) => {
	logJson('error', { event: 'crypto_recv_poller_fatal', message: err?.message ?? String(err), stack: err?.stack });
	process.exit(3);
});
