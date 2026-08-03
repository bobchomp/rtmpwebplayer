#!/bin/sh
# Invoked by nginx-rtmp's exec_publish_done directive with the stream key as
# $1. Just signals this stream's recording ffmpeg process (if recording was
# on) to finish cleanly - SIGINT rather than a plain kill, so ffmpeg
# finalizes the file rather than leaving it truncated/corrupt. The actual
# finalize-and-upload handoff to the backend lives in record-start.sh, which
# is `wait`-ing on this same PID and reacts the moment it exits, whether
# that's because of this signal or because it hit its own recording-length
# cap on its own.
set -u

STREAM_KEY="$1"
PIDFILE="/tmp/recording-pids/${STREAM_KEY}.pid"

[ -f "$PIDFILE" ] || exit 0

kill -INT "$(cat "$PIDFILE")" 2>/dev/null
