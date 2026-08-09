const express = require('express');
const fs = require('fs');
const { readDb, writeDb } = require('../db');
const youtube = require('../youtube');
const recordings = require('../recordings');
const recordingSessions = require('../recordingSessions');
const { IS_DEV_SITE } = require('../devBanner');

const router = express.Router();

function checkSecret(req, res) {
  const expected = process.env.WEBHOOK_SECRET;
  if (!expected || req.query.secret !== expected) {
    res.status(403).send('Forbidden');
    return false;
  }
  return true;
}

function findChannelByKey(db, streamKey) {
  return Object.values(db.channels).find((c) => c.streamKey === streamKey);
}

// A brand-new RTMP connection is accepted (and the encoder needs the ack)
// well before nginx has actually written a usable HLS segment - especially
// with a CDN in front, where the very first requests can take a few extra
// seconds to settle. Waiting this long before flipping isLive means nobody
// (dashboard included) ever sees "live" during that window, so there's
// never a moment where the play button is visible but silently can't do
// anything yet. Doesn't affect YouTube relaying - relay-start.sh already
// polls separately for when that becomes ready.
const LIVE_DELAY_MS = Number(process.env.LIVE_DELAY_MS) || 15000;

// Keyed by channel id - lets a quick reconnect (or a disconnect before the
// delay elapses) cancel a still-pending "go live" from an earlier publish
// rather than stacking up or firing late for a stream that already ended.
const pendingLiveTimers = {};

function cancelPendingLive(channelId) {
  if (pendingLiveTimers[channelId]) {
    clearTimeout(pendingLiveTimers[channelId]);
    delete pendingLiveTimers[channelId];
  }
}

// Called by nginx-rtmp when a publisher starts pushing to /live/<streamKey>.
// Returning non-2xx here rejects the publish, so this doubles as stream-key auth.
router.post('/on_publish', (req, res) => {
  if (!checkSecret(req, res)) return;

  const streamKey = req.body.name;
  const db = readDb();
  const channel = findChannelByKey(db, streamKey);
  if (!channel) return res.status(403).send('Invalid stream key');

  (channel.outputs || []).forEach((output) => {
    if (output.type === 'youtube') {
      output.broadcastId = null;
      output.ingestAddress = null;
      output.streamName = null;
    }
  });
  writeDb(db);

  // Respond immediately so the publish isn't delayed - nginx is waiting on
  // this HTTP response to decide whether to accept the connection at all.
  res.status(200).send('OK');

  cancelPendingLive(channel.id);
  pendingLiveTimers[channel.id] = setTimeout(() => {
    delete pendingLiveTimers[channel.id];
    // This runs detached from any request/promise chain, so an uncaught
    // throw here (e.g. ENOSPC from writeDb's fs.writeFileSync) would
    // otherwise crash the whole process instead of just this one channel.
    try {
      const freshDb = readDb();
      const freshChannel = freshDb.channels[channel.id];
      if (!freshChannel) return;
      freshChannel.isLive = true;
      freshChannel.lastLiveAt = new Date().toISOString();
      writeDb(freshDb);
    } catch (err) {
      console.error(`Failed to flip channel ${channel.id} live:`, err.message);
    }
  }, LIVE_DELAY_MS);

  // YouTube relaying is dev-site-only (see /api/config's youtubeEnabled and
  // index.js, which doesn't even mount /api/youtube on production) - this
  // guard means that stays true even for a leftover 'youtube' output from
  // before that gate existed, rather than relying solely on none being
  // creatable going forward.
  (IS_DEV_SITE ? channel.outputs || [] : [])
    .filter((output) => output.type === 'youtube' && output.enabled && output.refreshToken)
    .forEach((output) => {
      youtube
        .createBroadcastAndStream(output.refreshToken, channel.title, channel.description)
        .then((result) => {
          const freshDb = readDb();
          const freshChannel = freshDb.channels[channel.id];
          // Guard against the stream having already ended before YouTube's
          // API calls finished, so a late response can't resurrect stale state.
          if (!freshChannel || !freshChannel.isLive) return;
          const freshOutput = (freshChannel.outputs || []).find((o) => o.id === output.id);
          if (freshOutput) {
            freshOutput.broadcastId = result.broadcastId;
            freshOutput.ingestAddress = result.ingestionAddress;
            freshOutput.streamName = result.streamName;
            writeDb(freshDb);
          }
        })
        .catch((err) => {
          console.error(
            `Failed to create YouTube broadcast for channel ${channel.id} output ${output.id}:`,
            err.message
          );
        });
    });
});

// Called by nginx-rtmp when the publisher disconnects.
router.post('/on_publish_done', (req, res) => {
  if (!checkSecret(req, res)) return;

  const streamKey = req.body.name;
  recordingSessions.endSession(streamKey);
  const db = readDb();
  const channel = findChannelByKey(db, streamKey);
  if (channel) {
    cancelPendingLive(channel.id);
    channel.isLive = false;
    (channel.outputs || []).forEach((output) => {
      if (output.type === 'youtube') {
        output.broadcastId = null;
        output.ingestAddress = null;
        output.streamName = null;
      }
    });
    writeDb(db);
  }
  res.status(200).send('OK');
});

// Internal only (protected by WEBHOOK_SECRET) - used by the rtmp container's
// relay-start.sh script (polled repeatedly for ~12s after publish starts,
// since a YouTube broadcast takes a couple of seconds to become ready while
// custom RTMP outputs are ready instantly) to find every destination
// currently enabled and ready to relay this stream to.
//
// Plain text, one "id<TAB>rtmp-url" pair per line (tab rather than a more
// common character like "|" or "," since neither is guaranteed absent from
// a pasted stream key) - empty body means nothing is ready (yet, or ever).
router.get('/relay-targets', (req, res) => {
  if (!checkSecret(req, res)) return;

  const streamKey = req.query.streamKey;
  const db = readDb();
  const channel = findChannelByKey(db, streamKey);
  if (!channel) return res.type('text/plain').send('');

  const lines = [];

  (channel.outputs || []).forEach((output) => {
    if (!output.enabled) return;
    // Same dev-site-only guard as on_publish above.
    if (IS_DEV_SITE && output.type === 'youtube' && output.ingestAddress && output.streamName) {
      lines.push(`${output.id}\t${output.ingestAddress}/${output.streamName}`);
    } else if (output.type === 'rtmp' && output.rtmpUrl && output.streamKey) {
      lines.push(`${output.id}\t${output.rtmpUrl}/${output.streamKey}`);
    }
  });

  res.type('text/plain').send(lines.join('\n'));
});

// Internal only (protected by WEBHOOK_SECRET) - checked once by the rtmp
// container's record-start.sh script right as a publish starts, so recording
// (an opt-in, per-channel setting) can be turned on/off from the dashboard
// without touching nginx config. Plain "yes"/"no" text, same style as
// relay-targets above.
router.get('/recording-enabled', (req, res) => {
  if (!checkSecret(req, res)) return;

  const streamKey = req.query.streamKey;
  const db = readDb();
  const channel = findChannelByKey(db, streamKey);
  const enabled = !!(channel && channel.recordingEnabled);
  if (enabled) recordingSessions.startSession(streamKey, channel.id);
  res.type('text/plain').send(enabled ? 'yes' : 'no');
});

// Internal only (protected by WEBHOOK_SECRET) - polled every ~30s by
// record-start.sh's own background watcher for as long as ffmpeg is
// running. Past RECORDING_WARN_HOURS this is what actually decides whether
// the recording keeps going - see recordingSessions.js for the warn/grace/
// auto-stop logic, and the "Continue recording?" prompt on the channel
// detail page for how an admin answers it.
router.get('/recording-should-continue', (req, res) => {
  if (!checkSecret(req, res)) return;

  const streamKey = req.query.streamKey;
  res.type('text/plain').send(recordingSessions.checkShouldContinue(streamKey));
});

// Internal only (protected by WEBHOOK_SECRET) - called by record-stop.sh
// once ffmpeg has actually finished writing the raw recording file. Kicks
// off the remux + R2 upload in the background - deliberately not awaited,
// since record-stop.sh doesn't wait on the response either (it backgrounds
// this call and moves on).
router.post('/recording-done', (req, res) => {
  if (!checkSecret(req, res)) return;

  const streamKey = req.body.streamKey;
  const rawFilePath = req.body.file;
  res.status(200).send('OK');

  if (streamKey) recordingSessions.endSession(streamKey);
  if (!streamKey || !rawFilePath) return;

  const db = readDb();
  const channel = findChannelByKey(db, streamKey);
  if (!channel) {
    // No channel to attribute this to (e.g. deleted mid-stream) - nothing
    // useful to do with the file, so just clean it up rather than leaving
    // it on disk forever.
    fs.rm(rawFilePath, { force: true }, () => {});
    return;
  }

  recordings.processFinishedRecording({ channel, rawFilePath }).catch((err) => {
    console.error(`Failed to process recording for channel ${channel.id}:`, err.message);
  });
});

module.exports = router;
