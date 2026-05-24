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
//                               executable. Default is the four
//                               .mjs/.sh scripts the data-api
//                               relies on.
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
import { dirname } from 'node:path';
import { hostname } from 'node:os';

import {
	parseShowOutput,
	classifyUnit,
	buildReport,
	diffReports,
	renderTelegramMessage,
	sendTelegram
} from '../src/ops-monitor.js';

const DEFAULTS = Object.freeze({
	UNITS: [
		// timer-driven oneshots (cadenceSec → interval grace)
		{ name: 'seneschal-private-watch-poller.service', timerName: 'seneschal-private-watch-poller.timer', intervalSec: 180 },
		{ name: 'seneschal-income-poller.service',         timerName: 'seneschal-income-poller.timer',         intervalSec: 3600 },
		{ name: 'seneschal-paymaster-sweep-check.service', timerName: 'seneschal-paymaster-sweep-check.timer', intervalSec: 86_400 },
		{ name: 'seneschal-backup.service',                timerName: 'seneschal-backup.timer',                intervalSec: 86_400 },
		// long-running services (no timer pair)
		{ name: 'seneschal-data-rest.service' },
		{ name: 'seneschal-data-mcp.service' }
	],
	SCRIPTS: [
		'/opt/seneschal-data-api/scripts/private-watch-poller.mjs',
		'/opt/seneschal-data-api/scripts/income-poller.mjs',
		'/opt/seneschal-data-api/scripts/paymaster-sweep-check.mjs',
		'/opt/seneschal-data-api/scripts/publish-docs.sh'
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

function systemctlShow(unit) {
	// We deliberately do NOT use --no-pager — `systemctl show`
	// doesn't paginate. We also tolerate exit != 0 (e.g. unit not
	// found) by returning an empty parse, so the classifier sees
	// status=unknown and the operator gets a clear delta.
	try {
		const out = execFileSync('/usr/bin/systemctl', ['show', unit,
			'-p', 'ActiveState',
			'-p', 'SubState',
			'-p', 'Result',
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

async function checkScript(path) {
	try {
		const s = await stat(path);
		if (!s.isFile()) return { status: 'missing', reason: 'not a regular file' };
		try {
			await access(path, FS.X_OK);
		}
		catch {
			return { status: 'missing', reason: 'not executable' };
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

	const report = buildReport({
		units: unitClassifications,
		scripts: scriptChecks,
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

main().catch(err => {
	console.error(JSON.stringify({
		t: new Date().toISOString(),
		event: 'ops_watchdog_crash',
		error: err?.stack ?? err?.message ?? String(err)
	}));
	process.exit(1);
});
