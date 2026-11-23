#!/bin/sh
# Invoked by nginx-rtmp's exec_publish directive with the stream key as $1.
# Runs for the whole stream, asking the backend every few seconds which
# outputs to send to (custom RTMP outputs, and YouTube/Facebook ones once
# their broadcast exists), and keeps one copy-only ffmpeg relay running per
# output. An output switched on mid-stream gets a relay on the next check;
# one switched off (or deleted) has its relay stopped. relay-stop.sh ends
# this script and every relay when the encoder disconnects; the backend
# answering 410 (the stream has ended) does the same, as a backstop.
set -u

STREAM_KEY="$1"
PIDDIR=/tmp/relay-pids
CHECK_EVERY=3
mkdir -p "$PIDDIR"
echo $$ > "${PIDDIR}/${STREAM_KEY}.supervisor"

start_relay() {
  target_id="$1"
  target_url="$2"
  # Restarts ffmpeg if it drops (e.g. the destination briefly refuses the
  # connection) until stopped; the TERM trap ends the loop and its current
  # ffmpeg. analyzeduration/probesize give a late-starting picture time to
  # be found, as a second line of defence behind nginx's wait_video.
  : > "${PIDDIR}/${STREAM_KEY}-${target_id}.log"
  (
    trap 'kill "$child" 2>/dev/null; exit 0' TERM
    child=
    while :; do
      ffmpeg -analyzeduration 15000000 -probesize 20000000 \
        -i "rtmp://127.0.0.1/live/${STREAM_KEY}" -map 0:v -map 0:a? -c copy -f flv "$target_url" \
        >> "${PIDDIR}/${STREAM_KEY}-${target_id}.log" 2>&1 &
      child=$!
      wait "$child"
      sleep 3
    done
  ) &
  echo $! > "${PIDDIR}/${STREAM_KEY}-${target_id}.pid"
  printf '%s' "$target_url" > "${PIDDIR}/${STREAM_KEY}-${target_id}.url"
}

stop_relay() {
  pidfile="$1"
  kill "$(cat "$pidfile")" 2>/dev/null
  rm -f "$pidfile" "${pidfile%.pid}.url"
}

stop_all() {
  for pidfile in "${PIDDIR}/${STREAM_KEY}-"*.pid; do
    [ -e "$pidfile" ] && stop_relay "$pidfile"
  done
}

while :; do
  RESPONSE=$(curl -s --max-time 5 -w '\n%{http_code}' "http://backend:4000/api/rtmp/relay-targets?streamKey=${STREAM_KEY}&secret=${WEBHOOK_SECRET}")
  CODE=$(printf '%s\n' "$RESPONSE" | tail -n 1)
  BODY=$(printf '%s\n' "$RESPONSE" | sed '$d')

  if [ "$CODE" = "410" ]; then
    stop_all
    rm -f "${PIDDIR}/${STREAM_KEY}.supervisor"
    exit 0
  fi

  # Anything but a clean answer (backend restarting, a timeout) changes
  # nothing: running relays carry on until the next check.
  if [ "$CODE" = "200" ]; then
    # Start new outputs, and restart any whose address changed (a new
    # Facebook live video gets a new one).
    printf '%s\n' "$BODY" | while IFS="$(printf '\t')" read -r target_id target_url; do
      [ -z "$target_id" ] && continue
      pidfile="${PIDDIR}/${STREAM_KEY}-${target_id}.pid"
      if [ -f "$pidfile" ]; then
        [ "$(cat "${PIDDIR}/${STREAM_KEY}-${target_id}.url" 2>/dev/null)" = "$target_url" ] && continue
        stop_relay "$pidfile"
      fi
      start_relay "$target_id" "$target_url"
    done

    # Stop outputs that are no longer listed (switched off or deleted).
    for pidfile in "${PIDDIR}/${STREAM_KEY}-"*.pid; do
      [ -e "$pidfile" ] || continue
      target_id=$(basename "$pidfile" .pid)
      target_id=${target_id#"${STREAM_KEY}-"}
      printf '%s\n' "$BODY" | cut -f1 | grep -qxF "$target_id" || stop_relay "$pidfile"
    done
  fi

  sleep "$CHECK_EVERY"
done
