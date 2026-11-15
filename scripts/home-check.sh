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
compose ps --format 'table {{.Service}}\t{{.Status}}'
for pair in api:7001 addon:7000 worker:7002; do
  if wait_ready "${pair%%:*}" "${pair##*:}"; then ok "${pair%%:*} ready"; else warn "${pair%%:*} NOT ready"; fi
done

say "Network"
IP="$(lan_ip)"
ok "server address in the home network: ${IP:-unknown}"
RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR == 1 { print $1 }' || true)"
if [ -n "$RESOLVED" ]; then ok "$DOMAIN points to $RESOLVED"; else warn "$DOMAIN does not resolve"; fi

if command -v curl >/dev/null 2>&1; then
  say "Through the proxy (https://$DOMAIN)"
  # First make sure the name really leads to THIS installation: the API's uptime seen through
  # the proxy must match the uptime inside the container. Only then is the token sent there —
  # a wrong or mistyped name could lead to someone else's server.
  uptime_of() { grep -o '"uptimeSeconds":[0-9]*' | cut -d: -f2; }
  remote="$(curl -s -m 10 "https://$DOMAIN/health" | uptime_of || true)"
  local_up="$(compose exec -T api node -e \
    "fetch('http://127.0.0.1:7001/health').then(r=>r.text()).then(t=>console.log(t))" 2>/dev/null | uptime_of || true)"
  if [ -z "$remote" ] || [ -z "$local_up" ] || [ $((remote - local_up)) -gt 5 ] || [ $((local_up - remote)) -gt 5 ]; then
    warn "https://$DOMAIN does NOT lead to this server (no valid certificate, or another server answers)."
    warn "Not sending the token there. Fix the name / proxy / certificate first (docs/DEPLOY_HOME.md)."
    exit 1
  fi
  ok "https://$DOMAIN leads to this server (valid HTTPS certificate)"
  code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$1" || true; }
  c="$(code "https://$DOMAIN/$TOKEN/manifest.json")"
  if [ "$c" = 200 ]; then ok "Stremio add-on answers"; else warn "Stremio add-on: HTTP ${c:-no answer} — check the custom location /<token> → port 7000"; fi
  if curl -s -m 10 "https://$DOMAIN/manifest.json" | grep -q 'local.ai-subtitle-cloud'; then
    warn "the add-on answers WITHOUT the token — check the proxy's custom location"
  else
    ok "without the token the add-on is not reachable"
  fi
else
  warn "curl is not installed: skipping the HTTPS checks (apt install curl)"
fi
