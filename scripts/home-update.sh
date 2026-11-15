#!/usr/bin/env bash
# Update to the newest version: fetch the code, rebuild, restart. Data and .env are kept;
# a backup is made first. Stremio keeps working (same address and token).
#
#   scripts/home-update.sh

# shellcheck source=scripts/home-common.sh
source "$(dirname "$0")/home-common.sh"

require_docker
say "Backup before updating"
"$ROOT/scripts/home-backup.sh"

say "Fetching the new version"
before="$(git rev-parse --short HEAD)"
git pull --ff-only
after="$(git rev-parse --short HEAD)"
if [ "$before" = "$after" ]; then ok "already up to date ($after)"; else ok "$before → $after"; fi

say "Rebuilding and restarting"
compose up -d --build --remove-orphans
for pair in api:7001 addon:7000 worker:7002; do
  if wait_ready "${pair%%:*}" "${pair##*:}"; then
    ok "${pair%%:*} ready"
  else
    fail "${pair%%:*} did not start — the backup is in ./backups (scripts/home-restore.sh)"
  fi
done
docker image prune -f >/dev/null 2>&1 || true
ok "done"
