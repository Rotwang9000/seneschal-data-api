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
	serviceName: 'Seneschal Data API',
	// Optional donation addresses. If set, the stats dashboard renders a
	// discreet "Support development" panel. Empty values are hidden by the
	// frontend so this stays out of the public surface unless the operator
	// opts in. Multiple chains supported for tipper convenience.
	donateEth: asString('SENESCHAL_DONATE_ETH', ''),
	donateBtc: asString('SENESCHAL_DONATE_BTC', ''),
	donateGithub: asString('SENESCHAL_DONATE_GITHUB', ''),
	donateMessage: asString('SENESCHAL_DONATE_MESSAGE', 'Seneschal runs on a single Helsinki box. Tips keep it online.'),

	// ── x402 paywall ──────────────────────────────────────────────────
	// Per-request micropayments via the x402 protocol (HTTP 402 + USDC
	// transferWithAuthorization). The paywall is off unless
	// X402_RECIPIENT_ADDRESS is set: in that case premium endpoints
	// answer normally on free-tier resources but answer 402 + payment
	// requirements on paid resources. Settlement is delegated to a
	// facilitator service (`X402_FACILITATOR_URL`); the operator never
	// holds the payer's private key or submits anything on-chain
	// themselves.
	x402Enabled: asString('X402_ENABLED', '') === '1',
	x402Network: asString('X402_NETWORK', 'eip155:8453'),
	x402RecipientAddress: asString('X402_RECIPIENT_ADDRESS', ''),
	// Mainnet facilitator. The public x402.org/facilitator only services
	// testnets (Base Sepolia / Solana Devnet / etc.) — using it on
	// eip155:8453 yields "Facilitator does not support exact" at boot.
	// OpenX402 is permissionless, no API key, supports Base mainnet
	// USDC with proper EIP-712 metadata. Override at any time via
	// X402_FACILITATOR_URL.
	x402FacilitatorUrl: asString('X402_FACILITATOR_URL', 'https://facilitator.openx402.ai'),
	// Price per call for each premium endpoint, expressed in the x402
	// Money format ("$0.05" = 5 ¢). The facilitator quotes the USDC
	// atomic amount on Base from this.
	x402FeedPrice: asString('X402_FEED_PRICE', '$0.05'),
	x402PaywallDescription: asString(
		'X402_PAYWALL_DESCRIPTION',
		'Premium Seneschal liquidation feed: full at-risk borrower set with profit estimates, market success rates, and recommended builder choice.'
	),
	x402MaxTimeoutSeconds: asInt('X402_MAX_TIMEOUT_SECONDS', 120),

	// ── Income telemetry ──────────────────────────────────────────────
	// Drives /v1/stats/income + the `income` block embedded in
	// /v1/stats/overview. All values are optional — when both
	// PAYMASTER_ADDRESS and X402_RECIPIENT_ADDRESS are empty the
	// feature is off and the panel hides itself.
	//
	// PAYMASTER_ADDRESS / ENTRYPOINT_ADDRESS / BASE_RPC_URL default to
	// the contracts we actually run (Seneschal paymaster v2 on Base
	// mainnet + canonical EntryPoint v0.7 + the PublicNode RPC). Override
	// when running a different deployment for testing.
	paymasterAddress: asString('PAYMASTER_ADDRESS', '0xb6E8d189285003cF0000388b01BA0C3433ee9f14'),
	entryPointAddress: asString('ENTRYPOINT_ADDRESS', '0x0000000071727De22E5E9d8BAf0edAc6f37da032'),
	baseRpcUrl: asString('BASE_RPC_URL', 'https://base-rpc.publicnode.com'),
	// Spot ETH/USD assumed when costing the paymaster ETH float. The
	// snapshot exposes this as `eth_usd_assumed` so the dashboard can
	// label numbers honestly. No need for live price feeds here — the
	// only consumer is a "roughly how much capital is parked?" stat.
	ethUsd: asInt('ETH_USD', 4200),
	// Income snapshot in-process cache TTL. The dashboard refreshes
	// every 30 s; 60 s of staleness halves RPC pressure with no
	// meaningful UX cost.
	incomeCacheTtlMs: asInt('INCOME_CACHE_TTL_MS', 60_000),
	// Path to the JSONL file that scripts/income-poller.mjs appends
	// daily snapshots to. The REST server reads this read-only to
	// power historical charts. Empty path = "no history yet, frontend
	// hides the chart".
	incomeSnapshotsPath: asString('SENESCHAL_INCOME_SNAPSHOTS', '/var/lib/seneschal-income/snapshots.jsonl')
});

export default config;
