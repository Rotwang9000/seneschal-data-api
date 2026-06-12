#!/usr/bin/env node
// Seneschal ops watchdog.
//
// Inspects the seneschal-* systemd units + the data-api script
// directory, builds a health report, persists it, and alerts on
// state changes via:
//   * Always: writes the JSON report to STATE_FILE
//             (default /var/lib/seneschal-ops-monitor/state.json),
//             and logs a one-line summary to stdout (captured by
//             systemd-journald).
//   * Optional: posts state-change deltas to Telegram if both
//     TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID env vars are set.
//
// Reads its config from env so the same binary runs in dev + prod:
//   SENESCHAL_OPS_UNITS       — comma list of "service[:cadenceSec]"
//                               pairs. Cadence is the expected
//                               timer interval; omit (no colon) for
//                               long-running services.
//   SENESCHAL_OPS_SCRIPTS     — comma list of absolute script
//                               paths to verify exist + are
//                               readable. (.mjs scripts run via
//                               `node script.mjs` don't need the +x
//                               bit, and rsync deploys routinely drop
//                               it, so requiring X_OK produced false
//                               "missing" alerts.) Default is the four
//                               .mjs/.sh scripts the data-api relies on.
//   SENESCHAL_OPS_PROBES      — JSON array of HTTP probe specs (see
//                               runProbe in src/ops-monitor.js), or
//                               "none" to disable. Defaults cover the
//                               fin1 tunnel forwards (monerod/zebra/
//                               NFPT on loopback) + the public x402
//                               paywall 402 challenge.
//   SENESCHAL_OPS_STATE_FILE  — where to persist the last report
//                               (default /var/lib/seneschal-ops-monitor/state.json)
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID — optional alert sink.
//
// Exit codes:
//   0 — overall ok
//   2 — degraded (one or more units / scripts unhealthy)
//   1 — watchdog itself crashed (uncaught error)

import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, stat, access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';

import {
	parseShowOutput,
	classifyUnit,
	buildReport,
	diffReports,
	renderTelegramMessage,
	sendTelegram,
	runProbe
} from '../src/ops-monitor.js';

const DEFAULTS = Object.freeze({
	UNITS: [
		// timer-driven oneshots (cadenceSec → interval grace)
		{ name: 'seneschal-private-watch-poller.service', timerName: 'seneschal-private-watch-poller.timer', intervalSec: 180 },
		{ name: 'seneschal-crypto-recv-poller.service',   timerName: 'seneschal-crypto-recv-poller.timer',   intervalSec: 60 },
		{ name: 'seneschal-income-poller.service',         timerName: 'seneschal-income-poller.timer',         intervalSec: 3600 },
		{ name: 'seneschal-paymaster-sweep-check.service', timerName: 'seneschal-paymaster-sweep-check.timer', intervalSec: 86_400 },
		{ name: 'seneschal-backup.service',                timerName: 'seneschal-backup.timer',                intervalSec: 86_400 },
		// long-running services (no timer pair)
		{ name: 'seneschal-data-rest.service' },
		{ name: 'seneschal-data-mcp.service' }
	],
	SCRIPTS: [
		'/opt/seneschal-data-api/scripts/private-watch-poller.mjs',
		'/opt/seneschal-data-api/scripts/crypto-recv-poller.mjs',
		'/opt/seneschal-data-api/scripts/income-poller.mjs',
		'/opt/seneschal-data-api/scripts/paymaster-sweep-check.mjs',
		'/opt/seneschal-data-api/scripts/publish-docs.sh'
	],
	// HTTP probes for what systemd can't see. The three loopback URLs
	// are the fin1 reverse-tunnel forwards — if the tunnel drops, every
	// unit stays green while the XMR/ZEC products 502 (exactly the
	// silent failure that hid the fin1-DNS bug for weeks). The paywall
	// probe asserts a paid route still answers 402 WITH a challenge
	// header: anything else means the API is down or giving data away.
	PROBES: [
		{ name: 'tunnel-monerod', url: 'http://127.0.0.1:18081/get_info', expectBodyIncludes: ['"synchronized": true'] },
		{ name: 'tunnel-zebra', url: 'http://127.0.0.1:8232/', method: 'POST', body: '{"jsonrpc":"1.0","id":"ops","method":"getblockchaininfo","params":[]}', expectBodyIncludes: ['"result"'] },
		{ name: 'tunnel-nfpt', url: 'http://127.0.0.1:3555/health', expectBodyIncludes: ['"status":"healthy"'] },
		{ name: 'paywall-402', url: 'https://api.seneschal.space/v1/q/xmr/height', expectStatus: 402, expectHeader: 'payment-required' }
	],
	STATE_FILE: '/var/lib/seneschal-ops-monitor/state.json'
});

function parseUnitList(envValue) {
	if (!envValue) return DEFAULTS.UNITS;
	return envValue.split(',').map(s => s.trim()).filter(Boolean).map(s => {
		const [name, intervalSec] = s.split(':');
		// Convention: if there's a paired timer with the same stem,
		// the operator should add `:cadenceSec`; otherwise we treat
		// it as a long-running service.
		const out = { name };
		if (intervalSec) {
			out.timerName = name.replace(/\.service$/, '.timer');
			out.intervalSec = parseInt(intervalSec, 10);
		}
		return out;
	});
}

function parseScriptList(envValue) {
	if (!envValue) return DEFAULTS.SCRIPTS;
	return envValue.split(',').map(s => s.trim()).filter(Boolean);
}

// SENESCHAL_OPS_PROBES is a JSON array of probe specs (see runProbe's
// JSDoc) because probes need nested fields (method, body, expected
// substrings) that the comma-list format used for units can't carry.
// Set it to the literal string "none" to disable probes on hosts that
// don't terminate the fin1 tunnel (e.g. dev boxes).
function parseProbeList(envValue) {
	if (!envValue) return DEFAULTS.PROBES;
	if (envValue.trim() === 'none') return [];
	const parsed = JSON.parse(envValue);
	if (!Array.isArray(parsed)) {
		throw new TypeError('SENESCHAL_OPS_PROBES must be a JSON array of probe specs or "none"');
	}
	return parsed;
}

function systemctlShow(unit) {
	// We deliberately do NOT use --no-pager — `systemctl show`
	// doesn't paginate. We also tolerate exit != 0 (e.g. unit not
	// found) by returning an empty parse, so the classifier sees
	// status=unknown and the operator gets a clear delta.
	//
	// `--timestamp=unix` makes LastTriggerUSec come back as
	// "@<seconds>.<micros>" instead of "Sun 2026-05-24 09:51 CEST",
	// which `parseSystemdTimestampMs` handles natively (no Date.parse
	// timezone-abbreviation guessing required). Older systemd that
	// doesn't recognise the flag silently ignores it and falls back
	// to the default human-readable form, which our parser also
	// handles — so this is a strict improvement either way.
	try {
		const out = execFileSync('/usr/bin/systemctl', ['show', unit,
			'--timestamp=unix',
			'-p', 'ActiveState',
			'-p', 'SubState',
			'-p', 'Result',
			'-p', 'ExecMainStatus',
			'-p', 'LastTriggerUSec',
			'-p', 'NRestarts',
			'-p', 'UnitFileState'
		], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
		return parseShowOutput(out);
	}
	catch {
		return {};
	}
}

export async function checkScript(path) {
	try {
		const s = await stat(path);
		if (!s.isFile()) return { status: 'missing', reason: 'not a regular file' };
		try {
			// Readability, not executability: these scripts run via
			// `node script.mjs` / `bash script.sh`, which only need to
			// READ the file. rsync deploys also routinely drop the +x
			// bit, so an X_OK check produced false "missing" alerts.
			await access(path, FS.R_OK);
		}
		catch {
			return { status: 'missing', reason: 'not readable' };
		}
		return { status: 'ok', sizeBytes: s.size, mtimeMs: s.mtimeMs };
	}
	catch (err) {
		return { status: 'missing', reason: err?.code ?? String(err) };
	}
}

async function loadPriorReport(path) {
	try {
		const buf = await readFile(path, 'utf8');
		return JSON.parse(buf);
	}
	catch {
		return null;
	}
}

async function savePriorReport(path, report) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(report, null, 2));
}

async function main() {
	const nowMs = Date.now();
	const units = parseUnitList(process.env.SENESCHAL_OPS_UNITS);
	const scripts = parseScriptList(process.env.SENESCHAL_OPS_SCRIPTS);
	const probes = parseProbeList(process.env.SENESCHAL_OPS_PROBES);
	const stateFile = process.env.SENESCHAL_OPS_STATE_FILE ?? DEFAULTS.STATE_FILE;

	const unitClassifications = {};
	for (const u of units) {
		const serviceShow = systemctlShow(u.name);
		const timerShow = u.timerName ? systemctlShow(u.timerName) : null;
		unitClassifications[u.name] = classifyUnit({
			service: serviceShow,
			timer: timerShow,
			expected: u.intervalSec ? { intervalMs: u.intervalSec * 1000 } : null,
			nowMs
		});
	}

	const scriptChecks = {};
	for (const p of scripts) {
		scriptChecks[p] = await checkScript(p);
	}

	// Probes are independent network calls — run them concurrently so a
	// slow/timing-out endpoint doesn't serialise the whole tick.
	const probeResults = {};
	const probeOutcomes = await Promise.all(probes.map((p) => runProbe(p)));
	probes.forEach((p, i) => { probeResults[p.name] = probeOutcomes[i]; });

	const report = buildReport({
		units: unitClassifications,
		scripts: scriptChecks,
		probes: probeResults,
		nowMs
	});

	const prior = await loadPriorReport(stateFile);
	const changes = diffReports(prior, report);

	// Always log the summary so journalctl tells a continuous
	// story even when nothing changed.
	console.log(JSON.stringify({
		t: new Date(nowMs).toISOString(),
		event: 'ops_watchdog_tick',
		overall: report.overall,
		summary: report.summary,
		changes
	}));

	if (changes.length > 0) {
		console.warn(JSON.stringify({
			t: new Date(nowMs).toISOString(),
			event: 'ops_watchdog_change',
			level: report.overall === 'ok' ? 'recovery' : 'alert',
			changes
		}));
		const text = renderTelegramMessage({
			changes,
			report,
			host: hostname()
		});
		const tg = await sendTelegram({
			botToken: process.env.TELEGRAM_BOT_TOKEN,
			chatId: process.env.TELEGRAM_CHAT_ID,
			text
		});
		console.log(JSON.stringify({
			t: new Date(nowMs).toISOString(),
			event: 'ops_watchdog_alert',
			telegram: tg
		}));
	}

	await savePriorReport(stateFile, report);
	process.exit(report.overall === 'ok' ? 0 : 2);
}

// Only auto-run when invoked directly (systemd / CLI), NOT when
// imported by the test suite. argv[1] is resolved to an absolute
// path because systemd's ExecStart uses a WorkingDirectory-relative
// path ("scripts/seneschal-ops-monitor.mjs").
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	main().catch(err => {
		console.error(JSON.stringify({
			t: new Date().toISOString(),
			event: 'ops_watchdog_crash',
			error: err?.stack ?? err?.message ?? String(err)
		}));
		process.exit(1);
	});
}
