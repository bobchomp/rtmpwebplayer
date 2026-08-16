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
# A last-resort backstop only - the real cap is enforced by the backend (see
# RECORDING_WARN_HOURS/RECORDING_GRACE_MINUTES and the poller loop below),
# which prompts the dashboard rather than just cutting recording off. This
# just guarantees ffmpeg can't run truly forever even if the backend/network
# is unreachable for the entire recording.
SAFETY_SECONDS=$((48 * 3600))
echo "record-start.sh: recording ${STREAM_KEY} to ${OUTFILE}"

# Everything from here runs in one backgrounded subshell so it can `wait` on
# ffmpeg's own PID directly (a separate script invocation, like
# record-stop.sh, can't - it can only poll).
(
  # -use_wallclock_as_timestamps stamps each packet by when it actually
  # arrived rather than trusting the audio/video timestamps embedded in the
  # RTMP stream itself - nginx-rtmp's own live HLS mux of this same feed
  # plays back in sync, but this is a completely separate ffmpeg process
  # reading the stream over its own RTMP connection, and relying on the raw
  # embedded timestamps here was baking in a fixed A/V offset for the whole
  # recording (confirmed against a reproduction with a known offset - a
  # plain -c copy preserved it exactly, wallclock timestamping closed it to
  # a few ms). -avoid_negative_ts make_zero just keeps the output's own
  # starting point sane on top of that.
  ffmpeg -use_wallclock_as_timestamps 1 -i "rtmp://127.0.0.1/live/${STREAM_KEY}" \
    -c copy -avoid_negative_ts make_zero -t "$SAFETY_SECONDS" -f mpegts "$OUTFILE" \
    > "$LOGFILE" 2>&1 &
  FFMPEG_PID=$!
  echo "$FFMPEG_PID" > "${PIDDIR}/${STREAM_KEY}.pid"
  echo "$OUTFILE" > "${PIDDIR}/${STREAM_KEY}.file"

  # Polls the backend every 30s for as long as ffmpeg is running, asking
  # whether this recording should keep going. Past RECORDING_WARN_HOURS the
  # backend starts prompting the dashboard for a yes/no, and answers "stop"
  # itself if nobody responds within RECORDING_GRACE_MINUTES - either way,
  # this is what actually acts on that answer. Exits on its own the moment
  # ffmpeg does (via the kill -0 check), so it never outlives the recording
  # it's watching, and is killed explicitly below as a backstop in case
  # ffmpeg exits between one check and the next.
  (
    while kill -0 "$FFMPEG_PID" 2>/dev/null; do
      sleep 30
      DECISION=$(curl -s --max-time 5 "http://backend:4000/api/rtmp/recording-should-continue?streamKey=${STREAM_KEY}&secret=${WEBHOOK_SECRET}")
      if [ "$DECISION" = "stop" ]; then
        kill -INT "$FFMPEG_PID" 2>/dev/null
        break
      fi
    done
  ) &
  POLLER_PID=$!

  wait "$FFMPEG_PID"
  kill "$POLLER_PID" 2>/dev/null

  # ffmpeg has now exited - hit the safety cap, was sent SIGINT (by the
  # poller above or record-stop.sh), or errored. Finalize exactly once,
  # here, regardless of which it was.
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
