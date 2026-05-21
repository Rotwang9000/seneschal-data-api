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
	// Default price for /v1/q/* atomic-fact endpoints. Override per-route
	// is not currently supported — they share a single tier so agents can
	// budget a flat per-call cost.
	x402QPrice: asString('X402_Q_PRICE', '$0.001'),
	// Privacy-chain JSON-RPC endpoints. When unset the matching
	// /v1/q/xmr/* and /v1/q/zec/* routes answer HTTP 503 with
	// `chain_not_configured` rather than silently 502-ing. Defaults
	// to localhost since that's what a co-located node looks like;
	// production wiring uses the reverse-SSH tunnel established in
	// ops/systemd/seneschal-chain-tunnel.service.
	moneroRpcUrl: asString('MONERO_RPC_URL', 'http://127.0.0.1:18081'),
	zcashRpcUrl: asString('ZCASH_RPC_URL', 'http://127.0.0.1:8232'),
	chainCacheTtlMs: asInt('CHAIN_CACHE_TTL_MS', 10_000),
	chainRpcTimeoutMs: asInt('CHAIN_RPC_TIMEOUT_MS', 4_000),

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
	// Fallback ETH/USD price. The income snapshot now reads Chainlink
	// (`0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` on Base) for the
	// live price; this is only consulted when the oracle call fails.
	// `eth_usd_source` in the response tells the dashboard whether it
	// was `chainlink` (live) or `fallback`.
	ethUsd: asInt('ETH_USD', 2500),
	ethUsdFeed: asString('ETH_USD_FEED', '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70'),
	// Income snapshot in-process cache TTL. The dashboard refreshes
	// every 30 s; 60 s of staleness halves RPC pressure with no
	// meaningful UX cost.
	incomeCacheTtlMs: asInt('INCOME_CACHE_TTL_MS', 60_000),
	// Path to the JSONL file that scripts/income-poller.mjs appends
	// daily snapshots to. The REST server reads this read-only to
	// power historical charts. Empty path = "no history yet, frontend
	// hides the chart".
	incomeSnapshotsPath: asString('SENESCHAL_INCOME_SNAPSHOTS', '/var/lib/seneschal-income/snapshots.jsonl'),

	// ── Private watch (Phase 2 — view-key payment monitoring) ─────────
	// The data-api wraps the local NFPT wallet-scanner so agents can
	// pay one x402 fee for a 7-day "ping me when XMR/ZEC lands at this
	// address" subscription. View keys are encrypted at rest with a
	// 32-byte master key (PRIVATE_WATCH_ENCRYPTION_KEY); webhooks are
	// HMAC-SHA256 signed with a per-watch secret.
	//
	// NFPT runs on the same host as monerod/zebra (local box, port
	// 3555) and is reverse-tunnelled onto fin4's loopback by the same
	// systemd unit that exposes 18081 + 8232.
	nfptBaseUrl: asString('NFPT_BASE_URL', 'http://127.0.0.1:3555'),
	nfptApiKey: asString('NFPT_API_KEY', 'development-key-for-testing'),
	nfptTimeoutMs: asInt('NFPT_TIMEOUT_MS', 30_000),
	// Path to the watch SQLite DB. Writers: rest-server (new watch) +
	// poller (state updates). Reader: rest-server (status reads).
	// Defaults to the same /var/lib base as income-history so the
	// systemd unit can grant a single writable directory.
	privateWatchDbPath: asString('PRIVATE_WATCH_DB', '/var/lib/seneschal-data-api/private-watches.db'),
	// 64 hex chars = 32 bytes. The watch creation endpoint refuses to
	// accept requests until this is set, so a misconfigured deploy
	// can't silently store view keys in cleartext.
	privateWatchEncryptionKey: asString('PRIVATE_WATCH_ENCRYPTION_KEY', ''),
	// Allow http://127.0.0.1 / private RFC1918 webhook URLs — strictly
	// for local development. Production deployments leave this off so
	// SSRF protection is in force.
	privateWatchAllowPrivateWebhooks: asString('PRIVATE_WATCH_ALLOW_PRIVATE_WEBHOOKS', '') === '1',
	// Require https:// for webhook URLs. Default ON in production so a
	// cleartext token can't be sniffed off the wire. Local dev keeps it
	// off to support testing against an http listener.
	privateWatchRequireHttps: asString('PRIVATE_WATCH_REQUIRE_HTTPS', '1') === '1',
	// How often the poller drives a tick. Each tick polls every active
	// watch; NFPT detaches scanners after 5 min idle, so we stay
	// comfortably below.
	privateWatchPollIntervalSec: asInt('PRIVATE_WATCH_POLL_INTERVAL_SEC', 180),
	// HTTP timeout for outbound webhook POSTs. Set short — receivers
	// should accept fast and process async.
	privateWatchWebhookTimeoutMs: asInt('PRIVATE_WATCH_WEBHOOK_TIMEOUT_MS', 8_000),
	// Cap on bytes drained from a webhook receiver's response body.
	// We don't use the body — status code is the source of truth — so
	// a 4 KB cap defeats slow-loris megabyte responses.
	privateWatchResponseMaxBytes: asInt('PRIVATE_WATCH_RESPONSE_MAX_BYTES', 4 * 1024),
	// Max active watches per source IP — keeps a single client from
	// monopolising poller slots. Each is paywalled at $0.10 already
	// so this is mostly a soft DoS guard.
	privateWatchMaxPerIp: asInt('PRIVATE_WATCH_MAX_PER_IP', 32),
	// x402 price for POST /v1/private/watch. Buys the watch + the
	// STARTER_CREDIT_ATOMIC ($0.10 = 100_000 atomic USDC) opening
	// credit. Override via env for promos. The actual per-day +
	// per-call rates live in private-watch.js (WATCH_CONSTANTS) so
	// the meter logic is testable without env wiring.
	x402PrivateWatchPrice: asString('X402_PRIVATE_WATCH_PRICE', '$0.10'),
	// Three top-up tiers — same single-shot payment, larger
	// credit increments. The handler dispatches off the route path
	// to figure out how much credit to apply (TOPUP_10C_ATOMIC,
	// TOPUP_1_ATOMIC, TOPUP_5_ATOMIC).
	x402PrivateTopupPrice: asString('X402_PRIVATE_TOPUP_PRICE', '$0.10'),
	x402PrivateTopup1Price: asString('X402_PRIVATE_TOPUP_1_PRICE', '$1.00'),
	x402PrivateTopup5Price: asString('X402_PRIVATE_TOPUP_5_PRICE', '$5.00'),
	// Historical lookup: one-off scan, returns the spendable + spent
	// note breakdown for a view key without persisting anything. View
	// key flows through to NFPT in memory only.
	x402PrivateHistoricalPrice: asString('X402_PRIVATE_HISTORICAL_PRICE', '$0.50'),
	// Rate-limit budget for the FREE derive-viewkey endpoint. Stops
	// someone using us as a free seed-grinder. 6 calls / IP / minute
	// is enough for a developer iterating, way too slow for
	// brute-force.
	privateWatchDerivePerIpPerMin: asInt('PRIVATE_WATCH_DERIVE_PER_IP_PER_MIN', 6)
});

export default config;
