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
  (channel.outputs || []).forEach((output) => {
    if (output.type === 'youtube') {
      output.broadcastId = null;
      output.ingestAddress = null;
      output.streamName = null;
    }
  });
  writeDb(db);

  // Respond immediately so the publish isn't delayed waiting on YouTube's
  // API - the relay script (see rtmp/relay-start.sh) polls the endpoint
  // below separately until each output's ingest details are ready.
  res.status(200).send('OK');

  (channel.outputs || [])
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
  const db = readDb();
  const channel = findChannelByKey(db, streamKey);
  if (channel) {
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
    if (output.type === 'youtube' && output.ingestAddress && output.streamName) {
      lines.push(`${output.id}\t${output.ingestAddress}/${output.streamName}`);
    } else if (output.type === 'rtmp' && output.rtmpUrl && output.streamKey) {
      lines.push(`${output.id}\t${output.rtmpUrl}/${output.streamKey}`);
    }
  });

  res.type('text/plain').send(lines.join('\n'));
});

module.exports = router;
