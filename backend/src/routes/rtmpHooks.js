const express = require('express');
const { readDb, writeDb } = require('../db');
const youtube = require('../youtube');

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

// Called by nginx-rtmp when a publisher starts pushing to /live/<streamKey>.
// Returning non-2xx here rejects the publish, so this doubles as stream-key auth.
router.post('/on_publish', (req, res) => {
  if (!checkSecret(req, res)) return;

  const streamKey = req.body.name;
  const db = readDb();
  const channel = findChannelByKey(db, streamKey);
  if (!channel) return res.status(403).send('Invalid stream key');

  channel.isLive = true;
  channel.lastLiveAt = new Date().toISOString();
  channel.youtubeBroadcastId = null;
  channel.youtubeIngestAddress = null;
  channel.youtubeStreamName = null;
  writeDb(db);

  // Respond immediately so the publish isn't delayed waiting on YouTube's
  // API - the relay script (see rtmp/relay-start.sh) polls the endpoint
  // below separately until the ingest details are ready.
  res.status(200).send('OK');

  if (channel.youtubeEnabled && youtube.isConnected()) {
    youtube
      .createBroadcastAndStream(channel.youtubeTitle)
      .then((result) => {
        const freshDb = readDb();
        const freshChannel = freshDb.channels[channel.id];
        // Guard against the stream having already ended before YouTube's
        // API calls finished, so a late response can't resurrect stale state.
        if (freshChannel && freshChannel.isLive) {
          freshChannel.youtubeBroadcastId = result.broadcastId;
          freshChannel.youtubeIngestAddress = result.ingestionAddress;
          freshChannel.youtubeStreamName = result.streamName;
          writeDb(freshDb);
        }
      })
      .catch((err) => {
        console.error(`Failed to create YouTube broadcast for channel ${channel.id}:`, err.message);
      });
  }
});

// Called by nginx-rtmp when the publisher disconnects.
router.post('/on_publish_done', (req, res) => {
  if (!checkSecret(req, res)) return;

  const streamKey = req.body.name;
  const db = readDb();
  const channel = findChannelByKey(db, streamKey);
  if (channel) {
    channel.isLive = false;
    channel.youtubeBroadcastId = null;
    channel.youtubeIngestAddress = null;
    channel.youtubeStreamName = null;
    writeDb(db);
  }
  res.status(200).send('OK');
});

// Internal only (protected by WEBHOOK_SECRET) - used by the rtmp container's
// relay-start.sh script to find where to relay this stream for YouTube.
// Plain-text responses so the shell script doesn't need JSON parsing:
//   empty    -> not applicable for this stream, stop retrying
//   PENDING  -> enabled but the YouTube broadcast isn't ready yet, keep polling
//   anything else -> the full RTMP URL to relay to
router.get('/youtube-target', (req, res) => {
  if (!checkSecret(req, res)) return;

  const streamKey = req.query.streamKey;
  const db = readDb();
  const channel = findChannelByKey(db, streamKey);

  if (!channel || !channel.youtubeEnabled) {
    return res.type('text/plain').send('');
  }
  if (!channel.youtubeIngestAddress || !channel.youtubeStreamName) {
    return res.type('text/plain').send('PENDING');
  }
  res.type('text/plain').send(`${channel.youtubeIngestAddress}/${channel.youtubeStreamName}`);
});

module.exports = router;
