#!/bin/sh
# Invoked by nginx-rtmp's exec_publish_done directive with the stream key as
# $1. Stops this stream's recording ffmpeg process (if recording was on) and
# hands off to the backend for remuxing/upload once the file is fully
# flushed to disk. A plain `kill` alone isn't enough here - unlike the relay
# processes in relay-stop.sh (which are just being torn down, no output to
# preserve), this one needs SIGINT so ffmpeg finalizes the file cleanly
# rather than leaving it truncated/corrupt.
set -u

STREAM_KEY="$1"
PIDDIR=/tmp/recording-pids
PIDFILE="${PIDDIR}/${STREAM_KEY}.pid"
FILEFILE="${PIDDIR}/${STREAM_KEY}.file"

[ -f "$PIDFILE" ] || exit 0

PID=$(cat "$PIDFILE")
OUTFILE=$(cat "$FILEFILE" 2>/dev/null || echo "")
rm -f "$PIDFILE" "$FILEFILE"

kill -INT "$PID" 2>/dev/null

# record-start.sh backgrounded ffmpeg from a different script invocation, so
# this can't `wait` on it directly - poll for it to actually exit instead
# (up to ~10s) before handing the file off.
i=0
while kill -0 "$PID" 2>/dev/null && [ "$i" -lt 20 ]; do
  sleep 0.5
  i=$((i + 1))
done

# Surfaces ffmpeg's own output in `docker compose logs rtmp` - it otherwise
# only exists as a file inside this container, invisible unless someone
# execs in and goes looking for it by hand.
LOGFILE="${PIDDIR}/${STREAM_KEY}.log"
if [ -f "$LOGFILE" ]; then
  echo "record-stop.sh: ffmpeg output for ${STREAM_KEY} (${OUTFILE}):"
  cat "$LOGFILE"
  rm -f "$LOGFILE"
fi

[ -n "$OUTFILE" ] || exit 0

if [ ! -s "$OUTFILE" ]; then
  echo "record-stop.sh: ${OUTFILE} is missing or empty - ffmpeg likely failed to start (see log above); not notifying the backend"
  exit 0
fi

curl -s --max-time 10 -X POST "http://backend:4000/api/rtmp/recording-done?secret=${WEBHOOK_SECRET}" \
  -d "streamKey=${STREAM_KEY}" --data-urlencode "file=${OUTFILE}" > /dev/null 2>&1 &
