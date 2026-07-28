const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readDb, writeDb, DATA_DIR } = require('./db');
const geoip = require('./geoip');

const PLAYS_FILE = path.join(DATA_DIR, 'plays.json');

// A viewer who keeps watching (pausing/buffering/resuming) generates repeated
// "playing" events - within this window they're treated as one ongoing watch
// (only "latestPlayAt" moves), rather than a new row per resume. A gap longer
// than this means they've genuinely come back later, so it's a fresh row.
const SESSION_GAP_MS = 30 * 60 * 1000;

// A busy service start can mean dozens of viewers' first play event landing
// within the same few seconds. Writing plays.json straight through on every
// single one would mean that many synchronous full-file rewrites blocking
// Node's single thread back to back, and the file only grows over time as
// more history accumulates, so each of those rewrites gets more expensive
// the longer this has been running. Buffering in memory and only flushing
// on a timer turns "one disk write per viewer" into "at most one disk write
// per FLUSH_INTERVAL_MS", regardless of how many people show up at once.
const FLUSH_INTERVAL_MS = 5000;

// The embed player pings every 45s while actively playing (see embed.html) -
// double that gives one full missed beat of tolerance (a brief network hiccup,
// a slow tab) before someone still genuinely watching would drop out of the
// "currently watching" count.
const ACTIVE_VIEWER_WINDOW_MS = 90 * 1000;

let plays = null; // in-memory, authoritative between flushes - null means not loaded yet
let dirty = false;

function ensurePlaysFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PLAYS_FILE)) {
    fs.writeFileSync(PLAYS_FILE, JSON.stringify({ plays: [] }, null, 2));
  }
}

function readPlaysFile() {
  ensurePlaysFile();
  return JSON.parse(fs.readFileSync(PLAYS_FILE, 'utf8')).plays || [];
}

function writePlaysFile(rows) {
  ensurePlaysFile();
  const tmpFile = `${PLAYS_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify({ plays: rows }, null, 2));
  fs.renameSync(tmpFile, PLAYS_FILE);
}

// Loads plays.json into memory once. Also migrates the one-time case of an
// earlier version of this app that stored the plays array embedded directly
// in db.json instead of its own file - idempotent, since db.plays is deleted
// once migrated.
function ensureLoaded() {
  if (plays !== null) return;
  plays = readPlaysFile();

  const db = readDb();
  if (db.plays) {
    plays = plays.concat(db.plays);
    delete db.plays;
    writeDb(db);
    writePlaysFile(plays);
  }
}

function flush() {
  if (!dirty) return;
  writePlaysFile(plays);
  dirty = false;
}

function detectDeviceType(userAgent) {
  return /Mobi|Android|iPhone|iPod|iPad/i.test(userAgent || '') ? 'Mobile' : 'Desktop';
}

// Only ever touches the in-memory array - see FLUSH_INTERVAL_MS above for
// why this deliberately doesn't write to disk itself.
function recordPlay({ channelId, ip, userAgent }) {
  ensureLoaded();

  const db = readDb();
  const channel = db.channels[channelId];
  if (!channel) return;

  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const existing = plays.find(
    (p) =>
      p.channelId === channelId &&
      p.ip === ip &&
      now - new Date(p.latestPlayAt).getTime() < SESSION_GAP_MS
  );

  if (existing) {
    existing.latestPlayAt = nowIso;
    dirty = true;
    return;
  }

  const geo = geoip.lookupIp(ip);
  plays.push({
    id: crypto.randomUUID(),
    channelId,
    channelName: channel.name,
    title: channel.title || channel.name,
    description: channel.description || '',
    type: detectDeviceType(userAgent),
    ip,
    country: geo.country,
    region: geo.region,
    city: geo.city,
    firstPlayAt: nowIso,
    latestPlayAt: nowIso,
  });
  dirty = true;
}

// Reads straight from the in-memory array - always fully up to date
// regardless of the flush timer, since that's only about disk durability.
function listPlays({ channelId, from, to } = {}) {
  ensureLoaded();
  let rows = plays.slice();

  if (channelId) {
    rows = rows.filter((p) => p.channelId === channelId);
  }
  if (from) {
    const fromMs = new Date(from).getTime();
    rows = rows.filter((p) => new Date(p.latestPlayAt).getTime() >= fromMs);
  }
  if (to) {
    const toMs = new Date(to).getTime();
    rows = rows.filter((p) => new Date(p.latestPlayAt).getTime() <= toMs);
  }

  return rows.sort((a, b) => new Date(b.latestPlayAt) - new Date(a.latestPlayAt));
}

// Dashboard-only (see routes/channels.js) - never exposed on any public
// route. Counts distinct viewers (by IP) whose most recent heartbeat for
// this channel arrived within the last ACTIVE_VIEWER_WINDOW_MS, i.e. people
// who are plausibly still actually watching right now, not just everyone
// who's ever tuned in.
function countActiveViewers(channelId) {
  ensureLoaded();
  const now = Date.now();
  return plays.filter(
    (p) => p.channelId === channelId && now - new Date(p.latestPlayAt).getTime() < ACTIVE_VIEWER_WINDOW_MS
  ).length;
}

setInterval(flush, FLUSH_INTERVAL_MS).unref();

// Best-effort durability for whatever's still only in memory when the
// process stops (e.g. `docker compose restart`, which sends SIGTERM before
// killing it) - without this, up to FLUSH_INTERVAL_MS worth of play history
// could be lost on every single restart.
['SIGTERM', 'SIGINT'].forEach((signal) => {
  process.on(signal, () => {
    flush();
    process.exit(0);
  });
});

module.exports = { recordPlay, listPlays, countActiveViewers };
