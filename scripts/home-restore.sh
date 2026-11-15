#!/usr/bin/env bash
# Restore a backup made by scripts/home-backup.sh. The current data is not deleted:
# it is moved aside to data.before-restore-<time>.
#
#   scripts/home-restore.sh backups/asc-YYYYmmdd-HHMMSS.tar.gz

# shellcheck source=scripts/home-common.sh
source "$(dirname "$0")/home-common.sh"

FILE="${1:-}"
[ -n "$FILE" ] && [ -f "$FILE" ] || fail "Usage: scripts/home-restore.sh backups/asc-....tar.gz"
listing="$(tar -tzf "$FILE")" || fail "$FILE cannot be read."
grep -q '^data/db/' <<<"$listing" || fail "$FILE is not a backup of this application."

require_docker
say "Restoring $FILE"
compose stop api worker addon >/dev/null 2>&1 || true
stamp="$(date +%Y%m%d-%H%M%S)"
[ -d data ] && mv data "data.before-restore-$stamp" && ok "current data moved to data.before-restore-$stamp"
[ -f .env ] && cp .env ".env.before-restore-$stamp" && chmod 600 ".env.before-restore-$stamp"
tar -xzf "$FILE"
chmod 600 .env 2>/dev/null || true
ok "files restored"

compose up -d
for pair in api:7001 addon:7000 worker:7002; do
  if wait_ready "${pair%%:*}" "${pair##*:}"; then
    ok "${pair%%:*} ready"
  else
    fail "${pair%%:*} did not start"
  fi
done
