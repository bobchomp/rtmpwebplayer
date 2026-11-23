#!/bin/sh
# Invoked by nginx-rtmp's exec_publish_done directive with the stream key as
# $1. Stops relay-start.sh's checking loop first (so it can't start anything
# new), then every relay it started for this stream.
set -u

STREAM_KEY="$1"
PIDDIR=/tmp/relay-pids

SUPERVISOR="${PIDDIR}/${STREAM_KEY}.supervisor"
if [ -e "$SUPERVISOR" ]; then
  kill "$(cat "$SUPERVISOR")" 2>/dev/null
  rm -f "$SUPERVISOR"
fi

for PIDFILE in "${PIDDIR}/${STREAM_KEY}-"*.pid; do
  [ -e "$PIDFILE" ] || continue
  kill "$(cat "$PIDFILE")" 2>/dev/null
  rm -f "$PIDFILE" "${PIDFILE%.pid}.url"
done
