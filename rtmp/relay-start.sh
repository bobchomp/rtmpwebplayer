#!/bin/sh
# Invoked by nginx-rtmp's exec_publish directive with the stream key as $1.
# Asks the backend whether this stream should be relayed on to YouTube and,
# if so, where - then spawns a copy-only ffmpeg relay in the background.
set -u

STREAM_KEY="$1"
PIDDIR=/tmp/relay-pids
mkdir -p "$PIDDIR"

TARGET=""
i=0
while [ "$i" -lt 10 ]; do
  BODY=$(curl -s --max-time 5 "http://backend:4000/api/rtmp/youtube-target?streamKey=${STREAM_KEY}&secret=${WEBHOOK_SECRET}")

  if [ -z "$BODY" ]; then
    # Not applicable for this stream - nothing to do.
    exit 0
  fi

  if [ "$BODY" != "PENDING" ]; then
    TARGET="$BODY"
    break
  fi

  sleep 1
  i=$((i + 1))
done

if [ -z "$TARGET" ]; then
  # Gave up waiting for YouTube's broadcast to be created - stream continues
  # locally regardless, it just won't relay to YouTube this session.
  exit 0
fi

ffmpeg -i "rtmp://127.0.0.1/live/${STREAM_KEY}" -c copy -f flv "$TARGET" \
  > "${PIDDIR}/${STREAM_KEY}.log" 2>&1 &
echo $! > "${PIDDIR}/${STREAM_KEY}.pid"
