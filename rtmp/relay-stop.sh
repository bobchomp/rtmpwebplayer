#!/bin/sh
# Invoked by nginx-rtmp's exec_publish_done directive with the stream key as
# $1. Stops every relay process started for this stream (one per enabled
# custom RTMP output).
set -u

STREAM_KEY="$1"
PIDDIR=/tmp/relay-pids

for PIDFILE in "${PIDDIR}/${STREAM_KEY}-"*.pid; do
  [ -e "$PIDFILE" ] || continue
  PID=$(cat "$PIDFILE")
  kill "$PID" 2>/dev/null
  rm -f "$PIDFILE"
done
