const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ channels: {} }, null, 2));
  }
}

// Transparently upgrades older channel shapes into the current unified
// channel.outputs array, so deploying that change doesn't silently drop an
// already-connected YouTube account or existing custom RTMP outputs (both
// the dashboard listing AND actual relaying read from channel.outputs now).
// Idempotent - the old fields are removed once migrated, so this is a
// no-op on every read after the first.
function migrateChannel(channel) {
  channel.outputs = channel.outputs || [];

  // Pre-unified-outputs shape: a plain array of RTMP-only outputs.
  if (channel.customOutputs) {
    channel.customOutputs.forEach((output) => {
      channel.outputs.push(Object.assign({ type: 'rtmp' }, output));
    });
    delete channel.customOutputs;
  }

  // Pre-multiple-YouTube-connections shape: one connection object, plus a
  // separate whole-channel enabled flag and live-session fields.
  if (channel.youtube) {
    channel.outputs.push({
      id: crypto.randomUUID(),
      type: 'youtube',
      channelTitle: channel.youtube.channelTitle,
      refreshToken: channel.youtube.refreshToken,
      connectedAt: channel.youtube.connectedAt,
      enabled: channel.youtubeEnabled !== false,
      broadcastId: channel.youtubeBroadcastId || null,
      ingestAddress: channel.youtubeIngestAddress || null,
      streamName: channel.youtubeStreamName || null,
    });
    delete channel.youtube;
    delete channel.youtubeEnabled;
    delete channel.youtubeBroadcastId;
    delete channel.youtubeIngestAddress;
    delete channel.youtubeStreamName;
  }

  return channel;
}

function readDb() {
  ensureDb();
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  Object.values(db.channels || {}).forEach(migrateChannel);
  return db;
}

function writeDb(data) {
  ensureDb();
  const tmpFile = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, DB_FILE);
}

module.exports = { readDb, writeDb, DATA_DIR };
