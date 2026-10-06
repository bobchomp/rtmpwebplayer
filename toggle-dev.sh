#!/usr/bin/env bash
# Stops the dev site if it's currently running, starts it if it's stopped -
# whichever applies right now. Asks for confirmation either way, then (if
# it's stopping) runs stop-dev.sh's own live-check safeguard on top.
#
# Usage:
#   ./toggle-dev.sh          # ask, then stop if running / start if stopped
#   ./toggle-dev.sh --force  # skip both this confirmation and the live check
set -euo pipefail
cd "$(dirname "$0")"

FORCE=false
for arg in "$@"; do
  if [ "$arg" = "--force" ]; then
    FORCE=true
  fi
done

CID=$(docker compose ps -a -q dev-backend 2>/dev/null || true)
RUNNING=false
if [ -n "$CID" ]; then
  STATE=$(docker inspect -f '{{.State.Running}}' "$CID" 2>/dev/null || echo false)
  if [ "$STATE" = "true" ]; then
    RUNNING=true
  fi
fi

if [ "$RUNNING" = true ]; then
  echo "Dev site is currently running."
  if [ "$FORCE" = false ]; then
    read -r -p "Stop it? [y/N] " REPLY
    case "$REPLY" in
      y|Y|yes|YES) ;;
      *) echo "Aborted - dev site left running."; exit 1 ;;
    esac
  fi
  exec ./stop-dev.sh "$@"
else
  echo "Dev site is currently stopped."
  if [ "$FORCE" = false ]; then
    read -r -p "Start it? [y/N] " REPLY
    case "$REPLY" in
      y|Y|yes|YES) ;;
      *) echo "Aborted - dev site left stopped."; exit 1 ;;
    esac
  fi
  exec ./start-dev.sh "$@"
fi
