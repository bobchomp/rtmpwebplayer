// Tracks in-progress recordings (as opposed to recordings.js, which tracks
// already-finished ones) so a single recording can be capped at
// RECORDING_WARN_HOURS without just silently cutting it off - instead the
// dashboard is offered a "keep recording?" choice, with a no-response grace
// period after which it stops on its own. Deliberately in-memory only, not
// persisted to disk - a backend restart mid-recording just resets the
// warning clock, which is a minor, acceptable edge case for something this
// transient (the recording itself keeps going either way; see
// record-start.sh, which owns the actual ffmpeg process and survives a
// backend restart independently).
const RECORDING_WARN_HOURS = Number(process.env.RECORDING_WARN_HOURS) || 4;
const RECORDING_GRACE_MINUTES = Number(process.env.RECORDING_GRACE_MINUTES) || 15;

const sessions = new Map(); // streamKey -> { channelId, startedAt, warnedAt, decision }

function startSession(streamKey, channelId) {
  sessions.set(streamKey, { channelId, startedAt: Date.now(), warnedAt: null, decision: null });
}

function endSession(streamKey) {
  sessions.delete(streamKey);
}

// Called repeatedly (every ~30s) by record-start.sh's poller for as long as
// ffmpeg is running. Returns 'continue' or 'stop' - the only two things the
// shell script cares about acting on.
function checkShouldContinue(streamKey) {
  const session = sessions.get(streamKey);
  if (!session) return 'continue'; // no session tracked (e.g. backend restarted mid-recording) - fail open

  if (session.decision === 'stop') return 'stop';

  const now = Date.now();
  const warnAtMs = session.startedAt + RECORDING_WARN_HOURS * 60 * 60 * 1000;
  if (now < warnAtMs) return 'continue';

  if (!session.warnedAt) {
    session.warnedAt = now; // first poll past the threshold - start showing the dashboard prompt
    return 'continue';
  }

  if (session.decision === 'continue') {
    // Admin said keep going - reset the clock so it warns again after
    // another full RECORDING_WARN_HOURS, rather than nagging on every poll.
    session.startedAt = now;
    session.warnedAt = null;
    session.decision = null;
    return 'continue';
  }

  // Still awaiting a response - auto-stop once the grace period lapses with
  // no answer, matching the original "forgot to stop it" failure mode this
  // whole thing exists to prevent.
  const graceDeadlineMs = session.warnedAt + RECORDING_GRACE_MINUTES * 60 * 1000;
  if (now >= graceDeadlineMs) {
    session.decision = 'stop';
    return 'stop';
  }
  return 'continue';
}

// Read-only status for the dashboard to poll and render a banner from.
function getStatus(streamKey) {
  const session = sessions.get(streamKey);
  if (!session) return null;
  return {
    startedAt: new Date(session.startedAt).toISOString(),
    awaitingConfirmation: !!session.warnedAt && !session.decision,
    graceDeadline: session.warnedAt
      ? new Date(session.warnedAt + RECORDING_GRACE_MINUTES * 60 * 1000).toISOString()
      : null,
  };
}

// The admin's answer to the dashboard prompt.
function recordDecision(streamKey, decision) {
  const session = sessions.get(streamKey);
  if (session) session.decision = decision;
}

module.exports = { startSession, endSession, checkShouldContinue, getStatus, recordDecision };
