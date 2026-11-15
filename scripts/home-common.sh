# Shared helpers for the home-server scripts. Sourced, not run.
# shellcheck shell=bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE="$ROOT/.env"
COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.home.yml)

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() {
  printf '  \033[31m✘ %s\033[0m\n' "$*" >&2
  exit 1
}

compose() { docker compose "${COMPOSE_FILES[@]}" "$@"; }

# Value of KEY in .env (empty when missing).
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  awk -F= -v k="$1" '$1 == k { sub(/^[^=]*=/, ""); v = $0 } END { print v }' "$ENV_FILE"
}

# Set KEY=VALUE in .env, replacing an existing line (commented or not) or appending.
env_set() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp "$ROOT/.env.tmp.XXXXXX")"
  KEY="$key" VALUE="$value" awk '
    BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"]; done = 0 }
    {
      line = $0
      sub(/^#[ \t]*/, "", line)
      if (!done && index(line, k "=") == 1) { print k "=" v; done = 1; next }
      print
    }
    END { if (!done) print k "=" v }
  ' "$ENV_FILE" >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

# The server's address in the home network (the source address of its default route).
lan_ip() {
  local ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }')"
  fi
  [ -n "$ip" ] || ip="$(hostname -I 2>/dev/null | awk '{ print $1 }')"
  printf '%s' "$ip"
}

# The home network in CIDR form, e.g. 192.168.1.0/24 (for the proxy's access list).
lan_subnet() {
  local ip="$1" subnet=""
  if command -v ip >/dev/null 2>&1; then
    subnet="$(ip -4 route show scope link 2>/dev/null | awk -v ip="$ip" '$0 ~ ("src " ip) { print $1; exit }')"
  fi
  [ -n "$subnet" ] || subnet="${ip%.*}.0/24"
  printf '%s' "$subnet"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || fail "Docker is not installed."
  docker info >/dev/null 2>&1 || fail "Docker is not running, or this user may not use it (try: sudo $0)."
  local version
  version="$(docker compose version --short 2>/dev/null || true)"
  [ -n "$version" ] || fail "The Docker Compose plugin is missing (apt install docker-compose-plugin)."
  # `!override` in docker-compose.home.yml needs Compose 2.24.4 or newer.
  if ! printf '%s\n%s\n' "2.24.4" "${version#v}" | sort -V -C; then
    fail "Docker Compose $version is too old; 2.24.4 or newer is needed."
  fi
  ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null), Compose $version"
}

# Wait until a service answers its readiness check inside its container.
wait_ready() {
  local service="$1" port="$2" _
  for _ in $(seq 1 60); do
    if compose exec -T "$service" node -e \
      "fetch('http://127.0.0.1:$port/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" \
      >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}
