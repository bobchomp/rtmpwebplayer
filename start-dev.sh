#!/usr/bin/env bash
# Starts the dev site (dev-backend, dev-rtmp) back up after ./stop-dev.sh.
# Safe to run even if it's already running.
set -euo pipefail
cd "$(dirname "$0")"

echo "Starting dev site..."
docker compose start
echo "Done."
