#!/usr/bin/env bash
# First installation (and safe re-run) on a home server behind Nginx Proxy Manager.
#
#   scripts/home-setup.sh <your-name.duckdns.org>
#
# What it does:
#   1. checks Docker;
#   2. prepares .env (keeps everything already in it): access token, public address,
#      file owner; never prints your API keys;
#   3. builds and starts the application, waits until it is ready;
#   4. prints exactly what to enter in Nginx Proxy Manager and in Stremio.
#
# Running it again is safe: an existing AUTH_TOKEN is kept, so Stremio keeps working.

# shellcheck source=scripts/home-common.sh
source "$(dirname "$0")/home-common.sh"

DOMAIN="${1:-}"
[ -n "$DOMAIN" ] || DOMAIN="$(env_get ASC_DOMAIN)"
[ -n "$DOMAIN" ] || fail "Usage: scripts/home-setup.sh <your-name.duckdns.org>"
DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN%%/*}"
DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')"
printf '%s' "$DOMAIN" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' ||
  fail "\"$DOMAIN\" is not a host name."

say "1/4 Docker"
require_docker

say "2/4 Configuration (.env)"
if [ ! -f "$ENV_FILE" ]; then
  cp .env.example "$ENV_FILE"
  ok "created .env from .env.example"
else
  cp "$ENV_FILE" "$ENV_FILE.backup-$(date +%Y%m%d-%H%M%S)"
  chmod 600 "$ENV_FILE".backup-*
  ok "kept the existing .env (a copy was saved next to it)"
fi
chmod 600 "$ENV_FILE"

TOKEN="$(env_get AUTH_TOKEN)"
if [ "${#TOKEN}" -lt 24 ]; then
  TOKEN="$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  env_set AUTH_TOKEN "$TOKEN"
  ok "generated a new access token"
else
  ok "kept the existing access token"
fi

# Files in ./data must belong to the user the containers run as.
OWNER_UID="${SUDO_UID:-$(id -u)}"
OWNER_GID="${SUDO_GID:-$(id -g)}"
env_set ASC_DOMAIN "$DOMAIN"
env_set ADDON_PUBLIC_URL "https://$DOMAIN"
env_set DASHBOARD_PUBLIC_URL "https://$DOMAIN"
env_set ASC_UID "$OWNER_UID"
env_set ASC_GID "$OWNER_GID"
mkdir -p data
chown -R "$OWNER_UID:$OWNER_GID" data 2>/dev/null || true
ok "public address https://$DOMAIN, files owned by $OWNER_UID:$OWNER_GID"

if [ -z "$(env_get ANTHROPIC_API_KEY)$(env_get OPENAI_API_KEY)$(env_get GEMINI_API_KEY)" ] &&
  [ "$(env_get MOCK_AI)" != "true" ]; then
  warn "no AI key in .env yet — add one later in the dashboard (Settings), no restart needed"
fi

say "3/4 Build and start (the first build takes a few minutes)"
compose up -d --build --remove-orphans
for pair in api:7001 addon:7000 worker:7002; do
  if wait_ready "${pair%%:*}" "${pair##*:}"; then
    ok "${pair%%:*} is ready"
  else
    compose ps
    fail "${pair%%:*} did not become ready — see: docker compose ${COMPOSE_FILES[*]} logs ${pair%%:*}"
  fi
done

IP="$(lan_ip)"
SUBNET="$(lan_subnet "$IP")"
[ -n "$IP" ] || IP="<server-ip>"

say "4/4 Done. Now set up Nginx Proxy Manager"
cat <<EOF

  Hosts → Proxy Hosts → Add Proxy Host

  [Details]
    Domain Names ............ $DOMAIN
    Scheme .................. http
    Forward Hostname / IP ... $IP
    Forward Port ............ 7001
    Block Common Exploits ... on
    Websockets Support ...... off (not needed)
    Access List ............. "Home network" (see below; recommended)

  [Custom locations] → Add location
    Define location ......... /$TOKEN
    Scheme .................. http
    Forward Hostname / IP ... $IP
    Forward Port ............ 7000

  [SSL]
    SSL Certificate ......... Request a new SSL Certificate
    Force SSL ............... on
    HTTP/2 Support .......... on
    (agree to the Let's Encrypt terms, Save)

  [Advanced] → Custom Nginx Configuration
    proxy_buffering off;
    proxy_read_timeout 1h;
    access_log off;
  (live progress needs the first two; the third keeps the token out of the proxy's logs)

  Access Lists → Add Access List  (keeps it to your home network)
    Name .................... Home network
    [Access] allow .......... $SUBNET
             deny ........... all

EOF

say "Stremio (Google TV): Add-ons → search field → paste:"
printf '\n    https://%s/%s/manifest.json\n' "$DOMAIN" "$TOKEN"
say "Dashboard (open once with the token; it is remembered):"
printf '\n    https://%s/?token=%s\n\n' "$DOMAIN" "$TOKEN"
warn "the token is in these addresses: treat them like a password"

RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR == 1 { print $1 }')"
if [ -z "$RESOLVED" ]; then
  warn "$DOMAIN does not resolve from this server — check the name at your DNS provider"
else
  ok "$DOMAIN currently points to $RESOLVED"
fi
printf '\nCheck everything at any time with: scripts/home-check.sh\n'
