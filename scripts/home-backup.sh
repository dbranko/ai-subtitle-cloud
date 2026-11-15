#!/usr/bin/env bash
# Back up everything needed to restore the installation: the database, translations,
# sources, the key that encrypts saved API keys (data/secret.key) and .env.
# The services are paused for a few seconds so the database file is consistent.
#
#   scripts/home-backup.sh            → backups/asc-YYYYmmdd-HHMMSS.tar.gz (last 10 kept)
#
# The archive contains your API keys and access token: keep it private.

# shellcheck source=scripts/home-common.sh
source "$(dirname "$0")/home-common.sh"

KEEP="${ASC_BACKUPS_KEEP:-10}"
mkdir -p backups
chmod 700 backups
FILE="backups/asc-$(date +%Y%m%d-%H%M%S).tar.gz"

running="$(compose ps --services --status running 2>/dev/null | grep -E '^(api|worker|addon)$' || true)"
if [ -n "$running" ]; then
  # shellcheck disable=SC2086
  compose stop $running >/dev/null
fi
restart() {
  if [ -n "$running" ]; then
    # shellcheck disable=SC2086
    compose start $running >/dev/null
    local service
    for service in $running; do
      case "$service" in
        api) wait_ready api 7001 || warn "api is not ready yet" ;;
        addon) wait_ready addon 7000 || warn "addon is not ready yet" ;;
        worker) wait_ready worker 7002 || warn "worker is not ready yet" ;;
      esac
    done
  fi
}
trap restart EXIT

files=(data)
[ -f .env ] && files+=(.env)
(umask 077 && tar -czf "$FILE" "${files[@]}")
trap - EXIT
restart

ok "backup: $FILE ($(du -h "$FILE" | cut -f1))"
# Keep the newest $KEEP archives.
find backups -maxdepth 1 -name 'asc-*.tar.gz' -printf '%T@ %p\n' | sort -rn | tail -n +"$((KEEP + 1))" |
  cut -d' ' -f2- | xargs -r rm -f
