const express = require('express');
const { readDb, writeDb } = require('../db');

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
  writeDb(db);
  res.status(200).send('OK');
});

// Called by nginx-rtmp when the publisher disconnects.
router.post('/on_publish_done', (req, res) => {
  if (!checkSecret(req, res)) return;

  const streamKey = req.body.name;
  const db = readDb();
  const channel = findChannelByKey(db, streamKey);
  if (channel) {
    channel.isLive = false;
    writeDb(db);
  }
  res.status(200).send('OK');
});

module.exports = router;
