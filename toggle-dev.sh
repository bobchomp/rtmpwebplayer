#!/usr/bin/env bash
# Stops the dev site if it's currently running, starts it if it's stopped -
# whichever applies right now. Same live-check safeguard as stop-dev.sh
# applies if it ends up stopping.
#
# Usage:
#   ./toggle-dev.sh          # stop if running, start if stopped
#   ./toggle-dev.sh --force  # skip the live check if it ends up stopping
set -euo pipefail
cd "$(dirname "$0")"

CID=$(docker compose ps -a -q dev-backend 2>/dev/null || true)
RUNNING=false
if [ -n "$CID" ]; then
  STATE=$(docker inspect -f '{{.State.Running}}' "$CID" 2>/dev/null || echo false)
  if [ "$STATE" = "true" ]; then
    RUNNING=true
  fi
fi

if [ "$RUNNING" = true ]; then
  exec ./stop-dev.sh "$@"
else
  exec ./start-dev.sh "$@"
fi
