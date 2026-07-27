#!/bin/sh
# Invoked by nginx-rtmp's exec_publish_done directive with the stream key as $1.
set -u

STREAM_KEY="$1"
PIDFILE="/tmp/relay-pids/${STREAM_KEY}.pid"

if [ -f "$PIDFILE" ]; then
  PID=$(cat "$PIDFILE")
  kill "$PID" 2>/dev/null
  rm -f "$PIDFILE"
fi
