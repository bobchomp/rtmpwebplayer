const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ channels: {} }, null, 2));
  }
}

// Transparently upgrades older channel shapes into the current unified
// channel.outputs array. Also drops anything left from the first, removed
// YouTube relay (old per-channel connection fields, and 'youtube' outputs
// that kept their Google token on the output itself), so those tokens stop
// being stored. Current YouTube outputs keep theirs in db.youtubeTokens - see
// youtube.js. Idempotent - a no-op on every read after the first.
const LEGACY_YOUTUBE_FIELDS = ['youtube', 'youtubeEnabled', 'youtubeBroadcastId', 'youtubeIngestAddress', 'youtubeStreamName'];

function migrateChannel(channel) {
  channel.outputs = channel.outputs || [];

  // Pre-unified-outputs shape: a plain array of RTMP-only outputs.
  if (channel.customOutputs) {
    channel.customOutputs.forEach((output) => {
      channel.outputs.push(Object.assign({ type: 'rtmp' }, output));
    });
    delete channel.customOutputs;
  }

  LEGACY_YOUTUBE_FIELDS.forEach((field) => delete channel[field]);
  channel.outputs = channel.outputs.filter((output) => !(output.type === 'youtube' && 'refreshToken' in output));

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
