// Environment-driven config with safe defaults. Single source of truth for
// paths, ports, limits — both rest and mcp servers import from here.

import { resolve } from 'node:path';

const env = process.env;

function asInt(key, fallback) {
	const raw = env[key];
	if (raw === undefined || raw === '') return fallback;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n)) {
		throw new Error(`config: ${key}=${raw} is not an integer`);
	}
	return n;
}

function asString(key, fallback) {
	const raw = env[key];
	return raw === undefined || raw === '' ? fallback : raw;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;
export const DEFAULT_HISTORY_GRANULARITY = 'raw';
export const HISTORY_GRANULARITIES = Object.freeze(['raw', 'hour', 'day']);
export const SUPPORTED_PROTOCOLS = Object.freeze(['aave', 'morpho', 'spark', 'compound']);

export const config = Object.freeze({
	restPort: asInt('SENESCHAL_REST_PORT', 8810),
	restHost: asString('SENESCHAL_REST_HOST', '127.0.0.1'),
	mcpPort: asInt('SENESCHAL_MCP_PORT', 8811),
	mcpHost: asString('SENESCHAL_MCP_HOST', '127.0.0.1'),
	// Paths to the live data the bot is already collecting. Reads only;
	// every connection opened by this service uses SQLITE_OPEN_READONLY.
	mevLogsDbPath: resolve(asString('SENESCHAL_MEV_LOGS_DB', '/opt/mevbot/data/mev-logs-1.db')),
	morphoBorrowersPath: resolve(asString('SENESCHAL_MORPHO_BORROWERS', '/opt/mevbot/data/morpho-borrowers-1.json')),
	sparkBorrowersPath: resolve(asString('SENESCHAL_SPARK_BORROWERS', '/opt/mevbot/data/spark-borrowers.json')),
	shadowBlocksPath: resolve(asString('SENESCHAL_SHADOW_BLOCKS', '/opt/mevbot/data/shadow-blocks.jsonl')),
	// SQLite busy-timeout. We don't want a runaway server holding writers
	// up, so cap at 500 ms then surface a 503.
	sqliteBusyTimeoutMs: asInt('SENESCHAL_SQLITE_BUSY_TIMEOUT_MS', 500),
	// In-memory cache TTL for derived/aggregated answers (e.g. builder
	// leaderboard, which streams 54k jsonl lines). 60 s is a reasonable
	// trade between staleness and CPU.
	leaderboardCacheTtlMs: asInt('SENESCHAL_LEADERBOARD_TTL_MS', 60_000),
	// Conservative per-IP request rate. Override via env if monitoring
	// shows headroom.
	rateLimitPerMin: asInt('SENESCHAL_RATE_LIMIT_PER_MIN', 120),
	rateLimitTimeWindowMs: 60_000,
	// API version stamped into responses.
	apiVersion: '0.1.0',
	serviceName: 'Seneschal Data API'
});

export default config;
