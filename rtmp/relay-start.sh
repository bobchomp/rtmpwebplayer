#!/bin/sh
# Invoked by nginx-rtmp's exec_publish directive with the stream key as $1.
# Polls the backend for every currently-enabled relay target (YouTube plus
# any custom RTMP outputs) and spawns one copy-only ffmpeg relay per target.
# Polls repeatedly for ~12s since YouTube's broadcast takes a few seconds to
# become ready while custom outputs are ready instantly - each poll only
# starts targets that aren't already running, so it's safe to see the same
# target again on a later poll.
set -u

STREAM_KEY="$1"
PIDDIR=/tmp/relay-pids
mkdir -p "$PIDDIR"

i=0
while [ "$i" -lt 6 ]; do
  BODY=$(curl -s --max-time 5 "http://backend:4000/api/rtmp/relay-targets?streamKey=${STREAM_KEY}&secret=${WEBHOOK_SECRET}")

  if [ -n "$BODY" ]; then
    echo "$BODY" | while IFS="$(printf '\t')" read -r target_id target_url; do
      [ -z "$target_id" ] && continue
      PIDFILE="${PIDDIR}/${STREAM_KEY}-${target_id}.pid"
      [ -f "$PIDFILE" ] && continue

      ffmpeg -i "rtmp://127.0.0.1/live/${STREAM_KEY}" -c copy -f flv "$target_url" \
        > "${PIDDIR}/${STREAM_KEY}-${target_id}.log" 2>&1 &
      echo $! > "$PIDFILE"
    done
  fi

  sleep 2
  i=$((i + 1))
done
