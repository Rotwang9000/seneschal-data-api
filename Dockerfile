# Minimal MCP-server image. Glama (and other registry build-bots) build
# this directly from the repo root.
#
# The image runs the MCP server (bin/mcp.mjs). The REST server is
# available as a separate entrypoint (bin/rest.mjs) but is not exposed
# by default — registries care about MCP introspection over Streamable
# HTTP, which is what this image serves.
#
# Defaults (override via env):
#   DATA_API_MCP_PORT=8811
#   DATA_API_HOST=0.0.0.0
#   DATA_API_DB_PATH=/data/mev-logs-1.db
#   DATA_API_SPARK_PATH=/data/spark-borrowers.json
#   DATA_API_SHADOW_PATH=/data/shadow-blocks.jsonl
#
# The container will start and pass MCP introspection (`tools/list`)
# even with no data mounted at /data — health endpoint returns ok and
# tools become available; queries against an empty DB simply return
# empty result sets.

FROM node:20-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --fund=false

FROM node:20-alpine AS runtime

ENV NODE_ENV=production
ENV DATA_API_MCP_PORT=8811
ENV DATA_API_HOST=0.0.0.0
ENV DATA_API_DB_PATH=/data/mev-logs-1.db
ENV DATA_API_SPARK_PATH=/data/spark-borrowers.json
ENV DATA_API_SHADOW_PATH=/data/shadow-blocks.jsonl

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN addgroup -S app && adduser -S -G app app \
	&& mkdir -p /data \
	&& chown -R app:app /app /data

USER app

EXPOSE 8811

# Liveness probe — passes once the MCP server is bound. Useful for
# `docker run --health-cmd` and for Glama's build-check workflow.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
	CMD wget -qO- http://127.0.0.1:8811/health || exit 1

CMD ["node", "bin/mcp.mjs"]
