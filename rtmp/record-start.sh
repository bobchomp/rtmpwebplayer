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
if ! mkdir -p "$OUTDIR" 2>&1; then
  echo "record-start.sh: could not create ${OUTDIR} - check /recordings volume permissions"
  exit 0
fi
OUTFILE="${OUTDIR}/$(date +%s).ts"
echo "record-start.sh: recording ${STREAM_KEY} to ${OUTFILE}"

# Redirected to a plain file (not piped through tee) - piping would back-
# ground the *pipeline*, so $! would capture the pipe's last command
# instead of ffmpeg itself, breaking record-stop.sh's ability to signal the
# right process. record-stop.sh prints this file's content to stdout once
# the stream ends, so it still shows up in `docker compose logs rtmp`
# without needing to exec into the container to find it.
ffmpeg -i "rtmp://127.0.0.1/live/${STREAM_KEY}" -c copy -f mpegts "$OUTFILE" \
  > "${PIDDIR}/${STREAM_KEY}.log" 2>&1 &
echo $! > "${PIDDIR}/${STREAM_KEY}.pid"
echo "$OUTFILE" > "${PIDDIR}/${STREAM_KEY}.file"
