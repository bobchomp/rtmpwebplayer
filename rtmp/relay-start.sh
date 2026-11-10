#!/bin/sh
# Invoked by nginx-rtmp's exec_publish directive with the stream key as $1.
# Polls the backend for every currently-enabled relay target (custom RTMP
# outputs, and direct YouTube outputs) and spawns one copy-only ffmpeg relay
# per target. Polls every 2s for up to a minute: custom RTMP targets appear
# straight away, YouTube ones only once their broadcast has been created
# (usually a few seconds). Each poll only starts targets that aren't already
# running, so it's safe to see the same target again on a later poll.
set -u

STREAM_KEY="$1"
PIDDIR=/tmp/relay-pids
mkdir -p "$PIDDIR"

i=0
while [ "$i" -lt 30 ]; do
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
