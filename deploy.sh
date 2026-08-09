#!/usr/bin/env bash
# Wraps `docker compose up -d --build` with a live-stream safety check.
#
# db.json lives inside each backend container's own Docker volume, not on
# the host filesystem, so live status is read via `docker compose exec`
# rather than reading a file directly - this also means a container that
# isn't running yet (e.g. the very first deploy) just fails the check
# harmlessly, since nothing could be live through it anyway.
#
# Usage:
#   ./deploy.sh              # rebuild everything, same as `docker compose up -d --build`
#   ./deploy.sh backend      # rebuild specific service(s) only
#   ./deploy.sh --force      # skip the live check entirely
set -euo pipefail
cd "$(dirname "$0")"

FORCE=false
ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--force" ]; then
    FORCE=true
  else
    ARGS+=("$arg")
  fi
done

# Prints "<label>|<channel name>|<minutes live>" for each currently-live
# channel on the given backend service, or nothing if none are live (or the
# container isn't running / db.json can't be read - fails open rather than
# blocking a deploy over an unrelated problem).
check_live() {
  local service="$1" label="$2" json
  json=$(docker compose exec -T "$service" cat /app/data/db.json 2>/dev/null) || return 0
  node -e '
    try {
      const db = JSON.parse(process.argv[2]);
      Object.values(db.channels || {})
        .filter((c) => c.isLive)
        .forEach((c) => {
          const mins = c.lastLiveAt
            ? Math.round((Date.now() - new Date(c.lastLiveAt).getTime()) / 60000)
            : null;
          console.log(process.argv[1] + "|" + c.name + "|" + (mins === null ? "?" : mins));
        });
    } catch (e) {
      // Malformed/unreadable db.json - treat as "nothing live" rather than blocking.
    }
  ' "$label" "$json"
}

if [ "$FORCE" = false ]; then
  LIVE="$( { check_live backend PRODUCTION; check_live dev-backend DEV; } )"
  if [ -n "$LIVE" ]; then
    echo "Currently LIVE:"
    while IFS='|' read -r site name mins; do
      echo "  - [$site] $name (live ~${mins} min)"
    done <<< "$LIVE"
    echo
    echo "Rebuilding now will drop the RTMP connection and cut the stream(s) above."
    read -r -p "Deploy anyway? [y/N] " REPLY
    case "$REPLY" in
      y|Y|yes|YES) ;;
      *) echo "Aborted - nothing was deployed."; exit 1 ;;
    esac
  fi
fi

echo "Deploying..."
docker compose up -d --build "${ARGS[@]}"
