#!/usr/bin/env bash
# Stops the dev-site containers (dev-backend, dev-rtmp) - checks first
# whether the dev channel is currently live, since stopping it drops the
# RTMP connection and takes the dev site offline, same concern as
# deploy.sh has for a rebuild.
#
# Usage:
#   ./stop-dev.sh          # check first, then stop
#   ./stop-dev.sh --force  # skip the live check
set -euo pipefail
cd "$(dirname "$0")"

FORCE=false
for arg in "$@"; do
  if [ "$arg" = "--force" ]; then
    FORCE=true
  fi
done

if [ "$FORCE" = false ]; then
  # Runs node *inside* the container via `exec`, not on the host - a bare
  # Docker host has no Node.js installed at all, only the app's containers do.
  LIVE=$(docker compose exec -T dev-backend node -e '
    try {
      const fs = require("fs");
      const db = JSON.parse(fs.readFileSync("/app/data/db.json", "utf8"));
      Object.values(db.channels || {})
        .filter((c) => c.isLive)
        .forEach((c) => {
          const mins = c.lastLiveAt
            ? Math.round((Date.now() - new Date(c.lastLiveAt).getTime()) / 60000)
            : null;
          console.log(c.name + "|" + (mins === null ? "?" : mins));
        });
    } catch (e) {
      // Malformed/unreadable db.json - treat as "nothing live" rather than blocking.
    }
  ' 2>/dev/null || true)

  if [ -n "$LIVE" ]; then
    echo "Currently LIVE on dev:"
    while IFS='|' read -r name mins; do
      echo "  - $name (live ~${mins} min)"
    done <<< "$LIVE"
    echo
    echo "Stopping now will drop the RTMP connection and cut the stream(s) above."
    read -r -p "Stop dev anyway? [y/N] " REPLY
    case "$REPLY" in
      y|Y|yes|YES) ;;
      *) echo "Aborted - dev site left running."; exit 1 ;;
    esac
  fi
fi

echo "Stopping dev site..."
docker compose stop dev-backend dev-rtmp
echo "Done. Start it again with ./start-dev.sh"
