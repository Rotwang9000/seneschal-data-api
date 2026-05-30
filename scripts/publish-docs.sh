#!/usr/bin/env bash
# Publish the static docs from this repo to the Caddy web roots on fin4.
#
# The data-api Caddy vhost layout is:
#   seneschal.space        -> /var/www/seneschal/index.html       (= docs/landing.html in this repo)
#   docs.seneschal.space   -> /var/www/seneschal/docs/index.html  (= docs/index.html in this repo)
#                             /var/www/seneschal/docs/paymaster.html
#   stats.seneschal.space  -> /var/www/seneschal/stats/index.html (= docs/stats.html in this repo)
#
# A previous deploy step rsyncs THIS repo's `docs/` to `/opt/seneschal-data-api/docs/`
# (which is the working tree for the REST service's /v1/private/info HTML hint
# and for code-locality). The web roots under /var/www/seneschal/ are SEPARATE
# and need to be refreshed after a docs edit.
#
# This script is the one place that knows the file-name mapping. Safe to re-run.
#
# Usage:
#   scripts/publish-docs.sh                   # remote: root@fin4 (default)
#   scripts/publish-docs.sh root@host         # remote: any host
#   SRC=/opt/seneschal-data-api scripts/publish-docs.sh   # promote from a different src
set -euo pipefail

REMOTE="${1:-root@fin4}"
SRC="${SRC:-/opt/seneschal-data-api}"
WEB_ROOT="/var/www/seneschal"

# Each mapping is "src_relative_to_$SRC/docs -> dst_relative_to_$WEB_ROOT".
MAPPINGS=(
	"landing.html:index.html"
	"index.html:docs/index.html"
	"stats.html:stats/index.html"
	"paymaster.html:docs/paymaster.html"
	"panel.html:panel/index.html"
	"privacy.html:privacy.html"
	"terms.html:terms.html"
	# Crawlability / AI-agent discovery — served at the apex domain, with
	# llms.txt + robots.txt also mirrored under the docs subdomain root.
	"llms.txt:llms.txt"
	"llms.txt:docs/llms.txt"
	"robots.txt:robots.txt"
	"robots.txt:docs/robots.txt"
	"sitemap.xml:sitemap.xml"
	"og.png:og.png"
	"og.png:docs/og.png"
	# Brand assets, downloadable over HTTPS (operator works over SSH, no local copy).
	"seneschal-avatar.png:brand/seneschal-avatar.png"
	"seneschal-banner.png:brand/seneschal-banner.png"
)

echo "Publishing docs from ${REMOTE}:${SRC}/docs to ${REMOTE}:${WEB_ROOT}"
ssh "${REMOTE}" "set -e
	for pair in ${MAPPINGS[*]@Q}; do
		src=\"${SRC}/docs/\${pair%%:*}\"
		dst=\"${WEB_ROOT}/\${pair##*:}\"
		if [ ! -f \"\${src}\" ]; then
			echo \"  SKIP \${src} (missing)\"
			continue
		fi
		mkdir -p \"\$(dirname \"\${dst}\")\"
		cp \"\${src}\" \"\${dst}\"
		chown caddy:caddy \"\${dst}\" 2>/dev/null || true
		echo \"  \${src} -> \${dst}\"
	done
"

echo "Done. No Caddy reload needed — the file_server serves the new content immediately."
