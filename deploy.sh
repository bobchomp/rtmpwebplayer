#!/usr/bin/env bash
# Wraps `docker compose up -d --build` with a live-stream safety check.
#
# db.json lives inside each backend container's own Docker volume, not on
# the host filesystem, so live status is read via `docker compose exec`
# rather than reading a file directly - this also means a container that
# isn't running yet (e.g. the very first deploy) just fails the check
# harmlessly, since nothing could be live through it anyway.
#
# Always asks for confirmation before deploying - a plain "Would you like to
# deploy?" if nothing's live, or a more pointed "Deploy anyway?" warning if
# something is. A bare (no services named) run also asks separately whether
# to rebuild the RTMP ingest server(s) - see below.
#
# Usage:
#   ./deploy.sh              # rebuild everything - asks first whether to include RTMP
#   ./deploy.sh backend      # rebuild specific service(s) only - no RTMP prompt, already scoped
#   ./deploy.sh --force      # skip every prompt entirely, full rebuild as before
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

# Whether any services were named explicitly on the command line - tracked
# before the RTMP prompt below can populate ARGS itself, since only the
# default (nothing named) path should ever be filtered by the dev-stopped
# check further down. Naming services explicitly is always respected as-is,
# including deliberately starting dev back up with `./deploy.sh dev-backend`.
NAMED_SERVICES=false
[ ${#ARGS[@]} -gt 0 ] && NAMED_SERVICES=true

# Whether the dev site is currently deliberately stopped (via
# ./toggle-dev.sh or ./stop-dev.sh), so a default/bare deploy can leave it
# that way instead of switching it back on. `docker compose up` brings up
# every service it's given regardless of that service's previous state - it
# has no idea "stopped" was a deliberate choice - so a bare deploy used to
# silently re-enable dev every time. Checked the same way toggle-dev.sh
# checks it: a container that exists but isn't running was deliberately
# stopped; one that doesn't exist yet (the very first deploy) hasn't been -
# that case should still get created normally.
DEV_STOPPED=false
DEV_CID=$(docker compose ps -a -q dev-backend 2>/dev/null || true)
if [ -n "$DEV_CID" ]; then
  DEV_STATE=$(docker inspect -f '{{.State.Running}}' "$DEV_CID" 2>/dev/null || echo true)
  [ "$DEV_STATE" = "true" ] || DEV_STOPPED=true
fi
if [ "$DEV_STOPPED" = true ] && [ "$NAMED_SERVICES" = false ]; then
  echo "Dev site is currently stopped (via toggle-dev.sh/stop-dev.sh) - leaving it stopped."
fi

# Rebuilding rtmp/dev-rtmp restarts the container actually holding the live
# RTMP connection - that drops any live stream outright, and (worse) can
# silently strand an in-progress recording's raw file forever if ffmpeg's
# finalize-and-upload handoff gets killed mid-flight (see README's
# recordings troubleshooting). Only asked on a bare "rebuild everything" run
# with no services named - naming specific services, or --force, means
# you've already made that call.
REBUILD_RTMP=true
if [ "$FORCE" = false ] && [ "$NAMED_SERVICES" = false ]; then
  read -r -p "Rebuild the RTMP ingest server(s) too? This drops any live stream and can strand an in-progress recording. [y/N] " RTMP_REPLY
  case "$RTMP_REPLY" in
    y|Y|yes|YES) ;;
    *) REBUILD_RTMP=false ;;
  esac
fi

# Whether this run touches rtmp/dev-rtmp at all - the above answer for a
# bare run, or a direct check of what was actually named otherwise.
if [ "$NAMED_SERVICES" = true ]; then
  REBUILD_RTMP=false
  for s in "${ARGS[@]}"; do
    case "$s" in
      rtmp|dev-rtmp) REBUILD_RTMP=true ;;
    esac
  done
fi

# Builds the actual default service list from scratch rather than leaving
# ARGS empty (which would mean "every service in docker-compose.yml" to the
# final `up` command) - that's the only way to keep dev out of it when it's
# stopped. docker compose has no "everything except X" flag, so this has to
# enumerate services explicitly - keep in sync with docker-compose.yml if a
# new service is ever added.
if [ "$NAMED_SERVICES" = false ]; then
  ALL_SERVICES=(rtmp backend dev-rtmp dev-backend caddy)
  ARGS=()
  for s in "${ALL_SERVICES[@]}"; do
    case "$s" in
      rtmp|dev-rtmp) [ "$REBUILD_RTMP" = true ] || continue ;;
    esac
    case "$s" in
      dev-backend|dev-rtmp) [ "$DEV_STOPPED" = false ] || continue ;;
    esac
    ARGS+=("$s")
  done
fi

# Prints "<label>|<channel name>|<minutes live>" for each currently-live
# channel on the given backend service, or nothing if none are live (or the
# container isn't running / db.json can't be read - fails open rather than
# blocking a deploy over an unrelated problem). Runs node *inside* the
# container via `exec` rather than on the host - a bare Docker host (like
# DigitalOcean's 1-Click Docker droplet) has no Node.js installed at all;
# it only exists inside the app's own containers.
check_live() {
  local service="$1" label="$2"
  docker compose exec -T "$service" node -e '
    try {
      const fs = require("fs");
      const db = JSON.parse(fs.readFileSync("/app/data/db.json", "utf8"));
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
  ' "$label" 2>/dev/null || true
}

if [ "$FORCE" = false ]; then
  LIVE="$( { check_live backend PRODUCTION; check_live dev-backend DEV; } )"
  if [ -n "$LIVE" ]; then
    echo "Currently LIVE:"
    while IFS='|' read -r site name mins; do
      echo "  - [$site] $name (live ~${mins} min)"
    done <<< "$LIVE"
    echo
    if [ "$REBUILD_RTMP" = true ]; then
      echo "Rebuilding now will drop the RTMP connection and cut the stream(s) above."
    else
      echo "RTMP itself isn't being rebuilt, so the stream(s) above should keep running - but a recording finishing mid-restart could still fail to upload."
    fi
    read -r -p "Deploy anyway? [y/N] " REPLY
  else
    read -r -p "Would you like to deploy? [y/N] " REPLY
  fi
  case "$REPLY" in
    y|Y|yes|YES) ;;
    *) echo "Aborted - nothing was deployed."; exit 1 ;;
  esac
fi

echo "Deploying..."
docker compose up -d --build "${ARGS[@]}"
