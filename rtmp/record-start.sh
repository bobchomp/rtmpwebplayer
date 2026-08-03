#!/bin/sh
# Invoked by nginx-rtmp's exec_publish directive with the stream key as $1.
# Checks with the backend whether this channel has recording turned on, and
# if so, spawns a copy-only ffmpeg process that writes the raw stream to a
# shared volume as it comes in. Recorded as MPEG-TS (not MP4) deliberately -
# TS has no upfront index to finalize, so it's safe to write indefinitely and
# survives being killed mid-stream; the backend remuxes it into a proper,
# seekable MP4 once recording stops (see recording-done).
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
LOGFILE="${PIDDIR}/${STREAM_KEY}.log"
MAX_SECONDS=$(( ${MAX_RECORDING_HOURS:-4} * 3600 ))
echo "record-start.sh: recording ${STREAM_KEY} to ${OUTFILE} (auto-cuts off after ${MAX_RECORDING_HOURS:-4}h if not stopped first)"

# Everything from here runs in one backgrounded subshell so it can `wait` on
# ffmpeg's own PID directly (a separate script invocation, like the old
# record-stop.sh, can't - it can only poll). -t caps a single recording at
# MAX_SECONDS regardless of whether the stream itself keeps going - a stream
# accidentally left running for days no longer means an unbounded local
# file; ffmpeg just stops writing on its own and this finalizes/uploads
# whatever was captured, the same way a normal, deliberate stop does. If the
# stream is still live at that point, recording simply doesn't resume until
# it's toggled off and on again - the admin has to notice, which is the
# point (this is a safety net for "forgot to stop it", not a resumable
# rotation scheme).
(
  ffmpeg -i "rtmp://127.0.0.1/live/${STREAM_KEY}" -c copy -t "$MAX_SECONDS" -f mpegts "$OUTFILE" \
    > "$LOGFILE" 2>&1 &
  FFMPEG_PID=$!
  echo "$FFMPEG_PID" > "${PIDDIR}/${STREAM_KEY}.pid"
  echo "$OUTFILE" > "${PIDDIR}/${STREAM_KEY}.file"
  wait "$FFMPEG_PID"

  # ffmpeg has now exited - hit the -t cap, was sent SIGINT by
  # record-stop.sh, or errored. Finalize exactly once, here, regardless of
  # which it was.
  rm -f "${PIDDIR}/${STREAM_KEY}.pid" "${PIDDIR}/${STREAM_KEY}.file"

  # Surfaces ffmpeg's own output in `docker compose logs rtmp` - it
  # otherwise only exists as a file inside this container, invisible unless
  # someone execs in and goes looking for it by hand.
  if [ -f "$LOGFILE" ]; then
    echo "record-start.sh: ffmpeg output for ${STREAM_KEY} (${OUTFILE}):"
    cat "$LOGFILE"
    rm -f "$LOGFILE"
  fi

  if [ ! -s "$OUTFILE" ]; then
    echo "record-start.sh: ${OUTFILE} is missing or empty - ffmpeg likely failed to start; not notifying the backend"
    exit 0
  fi

  curl -s --max-time 10 -X POST "http://backend:4000/api/rtmp/recording-done?secret=${WEBHOOK_SECRET}" \
    -d "streamKey=${STREAM_KEY}" --data-urlencode "file=${OUTFILE}" > /dev/null 2>&1
) &
