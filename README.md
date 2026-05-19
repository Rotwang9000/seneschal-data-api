# Seneschal Data API

[![ci](https://github.com/Rotwang9000/seneschal-data-api/actions/workflows/ci.yml/badge.svg)](https://github.com/Rotwang9000/seneschal-data-api/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Free, public, read-only REST + [Model Context Protocol](https://modelcontextprotocol.io)
server exposing real-time and historical DeFi liquidation telemetry for
Aave, Morpho, Spark and Compound on Ethereum mainnet, plus block-builder
market share data from the operator's own slot-by-slot shadow recorder.

## Live endpoints

| What                          | URL                              | Auth     |
|-------------------------------|----------------------------------|----------|
| REST API                      | `https://api.seneschal.space`    | None     |
| MCP (Streamable HTTP)         | `https://mcp.seneschal.space`    | None     |
| Docs                          | `https://docs.seneschal.space`   | -        |
| Live stats dashboard          | `https://stats.seneschal.space`  | -        |

Rate limit: 120 requests/min/IP at the REST host. The MCP host pipelines
requests over a single transport so the same limit applies per session.

## Quick start

### REST

```bash
curl 'https://api.seneschal.space/v1/liquidations/atrisk?max_hf=1.05&min_debt_usd=1000'
```

### MCP — Claude Desktop / Cursor / Continue

Add this to your MCP client config (e.g. `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "seneschal-data": {
      "url": "https://mcp.seneschal.space/"
    }
  }
}
```

Nine tools become available to your agent:

| Tool                                 | Purpose                                                              |
|--------------------------------------|----------------------------------------------------------------------|
| `seneschal_health`                   | Liveness + data freshness                                            |
| `seneschal_list_at_risk_borrowers`   | Find liquidatable positions across all DeFi                          |
| `seneschal_list_borrowers`           | Generic discovery / pagination over the full borrower set            |
| `seneschal_recent_liquidations`      | Recent on-chain liquidations (won by other liquidators or ourselves) |
| `seneschal_get_borrower`             | Latest state of one borrower across protocols                        |
| `seneschal_get_borrower_history`     | Time-series health-factor traces                                     |
| `seneschal_builder_leaderboard`      | Ethereum builder market share (24h, 7d, 30d, all-time)               |
| `seneschal_stats_overview`           | Aggregate snapshot powering the public dashboard, incl. operator activity (counts only — no profit fields) |
| `seneschal_flashloan_providers`      | Curated catalogue of mainnet flash-loan providers, incl. LP-side commit-capital paths where applicable     |

## REST endpoints

| Method | Path                                  | Notes                                                          |
|--------|---------------------------------------|----------------------------------------------------------------|
| `GET`  | `/v1/health`                          | Liveness + freshness probe                                     |
| `GET`  | `/v1/liquidations/atrisk`             | `?protocol&max_hf&min_debt_usd&limit`                          |
| `GET`  | `/v1/liquidations/recent`             | `?since_ms&protocol&limit`                                     |
| `GET`  | `/v1/borrowers`                       | `?protocol&min_hf&max_hf&min_debt_usd&max_debt_usd&sort_by&sort_dir&limit&offset` |
| `GET`  | `/v1/borrowers/:address`              | Cross-protocol borrower snapshot                               |
| `GET`  | `/v1/borrowers/:address/history`      | `?protocol=aave|morpho&since_ms&until_ms&granularity&limit`    |
| `GET`  | `/v1/builders/leaderboard`            | `?window=24h|7d|30d|all&limit`                                 |
| `GET`  | `/v1/stats/overview`                  | Aggregate snapshot for dashboards                              |
| `GET`  | `/v1/flashloan/providers`             | `?chain&max_fee_bps&multi_asset`                               |

Full details, parameter tables, and worked examples at
[`https://docs.seneschal.space`](https://docs.seneschal.space).

## Why this exists

Seneschal operates an Ethereum block builder
(`extra_data = Seneschal/0.1`) and a vertically-integrated liquidation
searcher. The searcher already tracks ~500 Morpho borrowers, 1,300+
Spark borrowers, every Aave V3 mainnet position with non-trivial debt,
and the winning builder of every slot since May 2026. Nobody else
publishes this combination, so we expose it.

Two protocols, one backend:

- **REST API** — dashboards, monitoring tools, anything that speaks HTTP.
- **MCP server** — AI agents (Claude, Cursor, Continue, etc.) using
  the Model Context Protocol.

## Local dev

```bash
git clone https://github.com/Rotwang9000/seneschal-data-api
cd seneschal-data-api
npm install
SENESCHAL_MEV_LOGS_DB=/path/to/your-mev-data.sqlite \
SENESCHAL_MORPHO_BORROWERS=/path/to/morpho-borrowers.json \
SENESCHAL_SPARK_BORROWERS=/path/to/spark-borrowers.json \
SENESCHAL_SHADOW_BLOCKS=/path/to/shadow-blocks.jsonl \
  node bin/rest.mjs
# in another shell:
curl http://127.0.0.1:8810/v1/health
```

## Docker

A `Dockerfile` is provided for self-hosting the MCP server:

```bash
docker build -t seneschal-data-api .
docker run -p 8811:8811 -v /path/to/your-data:/data seneschal-data-api
# point your MCP client at http://localhost:8811/
```

The data sources are SQLite + JSONL files written by the Seneschal bot.
Schemas are documented in `src/db.js`; if you have your own writer
producing the same shapes you can point this server at it.

## Tests

```bash
npm test
```

75 jest tests covering the query layer (in-memory SQLite fixtures), the
Fastify REST routes (via `fastify.inject`), and the MCP server (both
in-process via `InMemoryTransport` and end-to-end via
`StreamableHTTPClientTransport`). Plus `test/live-smoke.mjs` which
exercises the live `mcp.seneschal.space` endpoint over Streamable HTTP.

## Architecture

```
services/data-api/   ← this repository
├── bin/
│   ├── rest.mjs                  systemd entry — Fastify REST listener
│   └── mcp.mjs                   systemd entry — MCP HTTP listener
├── src/
│   ├── config.js                 env-driven config (ports, paths, limits)
│   ├── db.js                     better-sqlite3 read-only handle + JSON cache
│   ├── queries.js                pure functions used by both REST and MCP
│   ├── rest-server.js            Fastify app: `buildApp()` for tests, `start()` for prod
│   └── mcp-server.js             McpServer + StreamableHTTPServerTransport
├── docs/                         public docs served at docs.seneschal.space
└── test/                         queries / rest-server / mcp-server tests
```

Shared design rule: both REST and MCP layers are *thin* wrappers around
`queries.js`. Any new endpoint goes in `queries.js` first (with tests),
then both wrappers in the same commit.

## Premium tier (x402 paywall)

`src/queries-premium.js` plus `src/x402.js` add per-call payment to a
small family of `/v1/premium/*` endpoints (and `seneschal_premium_*`
MCP tools). The paywall is off unless the operator sets
`X402_RECIPIENT_ADDRESS`. Once set, unsigned requests get HTTP 402 with
machine-readable payment requirements, and an
[x402 facilitator](https://docs.x402.org) settles a signed
EIP-3009 `transferWithAuthorization` for USDC on Base mainnet.

### Configure

| Env var                    | Default                          | Notes                                                                  |
| -------------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| `X402_RECIPIENT_ADDRESS`   | (empty — paywall off)            | Recipient wallet on the chosen network. 0x-prefixed 20-byte hex.       |
| `X402_NETWORK`             | `eip155:8453` (Base mainnet)     | Any CAIP-2 EVM network the facilitator supports.                       |
| `X402_FACILITATOR_URL`     | `https://x402.org/facilitator`   | Use a production facilitator for mainnet (see x402.org/ecosystem).     |
| `X402_FEED_PRICE`          | `$0.05`                          | Money-formatted (`$0.05`) or atomic units (`50000`).                   |
| `X402_PAYWALL_DESCRIPTION` | …                                | Shown on `/`, `/v1/paywall`, and the stats dashboard.                  |
| `X402_MAX_TIMEOUT_SECONDS` | `120`                            | Maximum settlement window per call.                                    |

Free metadata endpoint (zero cost, no signature required):

```
curl https://api.seneschal.space/v1/paywall
```

returns the live network/recipient/price/route table so agents can
budget a session before opening a paid request.

## Support

- **Per-call payments** (preferred for agents): pay $0.05 USDC on Base
  to call `GET /v1/premium/opportunities`. See `/v1/paywall` for the
  live recipient + rails.
- **GitHub Sponsors**: the Sponsor button at the top of the repo
  (`.github/FUNDING.yml`).
- **Direct tips**: ETH / BTC addresses are surfaced on
  [stats.seneschal.space](https://stats.seneschal.space) once the
  operator sets `SENESCHAL_DONATE_ETH` / `SENESCHAL_DONATE_BTC`.

Seneschal runs on a single Helsinki box; every cent helps keep it
online.

## License

MIT &mdash; see [LICENSE](LICENSE).

## Operator contact

Seneschal is a single-operator Ethereum block builder and searcher
running an `rbuilder` fork from a co-located server in Helsinki.
Builder on-chain extra_data is `Seneschal/0.1`. Contact `@Rotwang9000`
on Discord.
