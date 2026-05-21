#!/usr/bin/env node
// Private-watch poller driver.
//
// Walks every active watch, asks NFPT for current balance state,
// fires signed webhooks on change, then exits. Designed to be driven
// by a systemd .timer running every 2-3 minutes (so we stay inside
// NFPT's 5-minute scanner-idle window).
//
// Configuration is via env, mirroring the REST server. The two
// must-have variables are:
//   PRIVATE_WATCH_ENCRYPTION_KEY  - 64-hex master key (decrypts view keys)
//   PRIVATE_WATCH_DB              - path to the watch SQLite DB
//
// Optional:
//   NFPT_BASE_URL                 - default http://127.0.0.1:3555
//   NFPT_API_KEY                  - default development-key-for-testing
//   PRIVATE_WATCH_WEBHOOK_TIMEOUT_MS - default 8000
//   LOG_LEVEL                     - 'info' | 'warn' | 'error' (best-effort)
//
// On failure we still emit one JSON summary line so the operator can
// see the poller fired even when the underlying tick blew up.

import config from '../src/config.js';
import { openWatchDb } from '../src/private-watch-store.js';
import { parseMasterKey } from '../src/private-watch-crypto.js';
import { createNfptClient } from '../src/private-watch-nfpt.js';
import { runPollerTick } from '../src/private-watch-poller.js';

function logJson(level, obj) {
	process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, ...obj })}\n`);
}

async function main() {
	if (!config.privateWatchEncryptionKey) {
		logJson('error', { event: 'private_watch_poller_skipped', reason: 'PRIVATE_WATCH_ENCRYPTION_KEY not set' });
		process.exit(0);
	}
	let masterKey;
	try { masterKey = parseMasterKey(config.privateWatchEncryptionKey); }
	catch (err) {
		logJson('error', { event: 'private_watch_poller_skipped', reason: `parseMasterKey: ${err?.message ?? err}` });
		process.exit(1);
	}
	const db = openWatchDb(config.privateWatchDbPath);
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
		const summary = await runPollerTick({
			db,
			masterKey,
			nfptClient,
			webhookTimeoutMs: config.privateWatchWebhookTimeoutMs,
			responseMaxBytes: config.privateWatchResponseMaxBytes,
			logger
		});
		logJson('info', { event: 'private_watch_tick', ...summary });
		process.exit(0);
	}
	catch (err) {
		logJson('error', { event: 'private_watch_tick_failed', message: err?.message ?? String(err), stack: err?.stack });
		process.exit(2);
	}
}

function flatten(obj) {
	if (!obj || typeof obj !== 'object') return {};
	return obj;
}

main().catch((err) => {
	logJson('error', { event: 'private_watch_poller_fatal', message: err?.message ?? String(err), stack: err?.stack });
	process.exit(3);
});
