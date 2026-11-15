#!/usr/bin/env bash
# Is everything running and reachable? Prints one line per check.
#
#   scripts/home-check.sh

# shellcheck source=scripts/home-common.sh
source "$(dirname "$0")/home-common.sh"

DOMAIN="$(env_get ASC_DOMAIN)"
TOKEN="$(env_get AUTH_TOKEN)"
[ -n "$DOMAIN" ] && [ -n "$TOKEN" ] || fail "Not set up yet: run scripts/home-setup.sh <your-name.duckdns.org>"

say "Containers"
require_docker
compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Health}}'
for pair in api:7001 addon:7000 worker:7002; do
  if wait_ready "${pair%%:*}" "${pair##*:}"; then ok "${pair%%:*} ready"; else warn "${pair%%:*} NOT ready"; fi
done

say "Network"
IP="$(lan_ip)"
ok "server address in the home network: ${IP:-unknown}"
RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR == 1 { print $1 }')"
if [ -n "$RESOLVED" ]; then ok "$DOMAIN points to $RESOLVED"; else warn "$DOMAIN does not resolve"; fi

if command -v curl >/dev/null 2>&1; then
  say "Through the proxy (https://$DOMAIN)"
  code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$1" || true; }
  c="$(code "https://$DOMAIN/health")"
  if [ "$c" = 200 ]; then ok "dashboard/API answers (HTTPS certificate valid)"; else warn "dashboard/API: HTTP ${c:-no answer}"; fi
  c="$(code "https://$DOMAIN/$TOKEN/manifest.json")"
  if [ "$c" = 200 ]; then ok "Stremio add-on answers"; else warn "Stremio add-on: HTTP ${c:-no answer}"; fi
  if curl -s -m 10 "https://$DOMAIN/manifest.json" | grep -q 'local.ai-subtitle-cloud'; then
    warn "the add-on answers WITHOUT the token — check the proxy's custom location"
  else
    ok "without the token the add-on is not reachable"
  fi
else
  warn "curl is not installed: skipping the HTTPS checks (apt install curl)"
fi
