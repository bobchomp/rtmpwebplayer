#!/usr/bin/env bash
# Starts the dev-site containers (dev-backend, dev-rtmp) back up after
# ./stop-dev.sh. Safe to run even if they're already running.
set -euo pipefail
cd "$(dirname "$0")"

echo "Starting dev site..."
docker compose start dev-backend dev-rtmp
echo "Done."
