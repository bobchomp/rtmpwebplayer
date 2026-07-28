#!/bin/sh
# Invoked by nginx-rtmp's exec_publish directive with the stream key as $1.
# Checks with the backend whether this channel has recording turned on, and
# if so, spawns a copy-only ffmpeg process that writes the raw stream to a
# shared volume as it comes in. Recorded as MPEG-TS (not MP4) deliberately -
# TS has no upfront index to finalize, so it's safe to write indefinitely and
# survives being killed mid-stream; the backend remuxes it into a proper,
# seekable MP4 once recording stops (see record-stop.sh / recording-done).
set -u

STREAM_KEY="$1"
PIDDIR=/tmp/recording-pids
mkdir -p "$PIDDIR"

ENABLED=$(curl -s --max-time 5 "http://backend:4000/api/rtmp/recording-enabled?streamKey=${STREAM_KEY}&secret=${WEBHOOK_SECRET}")
[ "$ENABLED" = "yes" ] || exit 0

OUTDIR="/recordings/raw/${STREAM_KEY}"
mkdir -p "$OUTDIR"
OUTFILE="${OUTDIR}/$(date +%s).ts"

ffmpeg -i "rtmp://127.0.0.1/live/${STREAM_KEY}" -c copy -f mpegts "$OUTFILE" \
  > "${PIDDIR}/${STREAM_KEY}.log" 2>&1 &
echo $! > "${PIDDIR}/${STREAM_KEY}.pid"
echo "$OUTFILE" > "${PIDDIR}/${STREAM_KEY}.file"
