const crypto = require('crypto');
const { readDb, writeDb } = require('./db');
const geoip = require('./geoip');

// A viewer who keeps watching (pausing/buffering/resuming) generates repeated
// "playing" events - within this window they're treated as one ongoing watch
// (only "latestPlayAt" moves), rather than a new row per resume. A gap longer
// than this means they've genuinely come back later, so it's a fresh row.
const SESSION_GAP_MS = 30 * 60 * 1000;

function detectDeviceType(userAgent) {
  return /Mobi|Android|iPhone|iPod|iPad/i.test(userAgent || '') ? 'Mobile' : 'Desktop';
}

function recordPlay({ channelId, ip, userAgent }) {
  const db = readDb();
  const channel = db.channels[channelId];
  if (!channel) return;

  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const existing = db.plays.find(
    (p) =>
      p.channelId === channelId &&
      p.ip === ip &&
      now - new Date(p.latestPlayAt).getTime() < SESSION_GAP_MS
  );

  if (existing) {
    existing.latestPlayAt = nowIso;
    writeDb(db);
    return;
  }

  const geo = geoip.lookupIp(ip);
  db.plays.push({
    id: crypto.randomUUID(),
    channelId,
    channelName: channel.name,
    title: channel.title || channel.name,
    type: detectDeviceType(userAgent),
    ip,
    country: geo.country,
    region: geo.region,
    city: geo.city,
    firstPlayAt: nowIso,
    latestPlayAt: nowIso,
  });
  writeDb(db);
}

function listPlays({ channelId, from, to } = {}) {
  const db = readDb();
  let plays = db.plays.slice();

  if (channelId) {
    plays = plays.filter((p) => p.channelId === channelId);
  }
  if (from) {
    const fromMs = new Date(from).getTime();
    plays = plays.filter((p) => new Date(p.latestPlayAt).getTime() >= fromMs);
  }
  if (to) {
    const toMs = new Date(to).getTime();
    plays = plays.filter((p) => new Date(p.latestPlayAt).getTime() <= toMs);
  }

  return plays.sort((a, b) => new Date(b.latestPlayAt) - new Date(a.latestPlayAt));
}

module.exports = { recordPlay, listPlays };
