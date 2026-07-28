const express = require('express');
const { readDb } = require('../db');
const { requireAuth } = require('../authMiddleware');
const plays = require('../plays');

const router = express.Router();

// Cloudflare (and most CDNs) set this to the actual visitor's IP - req.ip
// would otherwise reflect the CDN/proxy hop instead, even with Express's
// trust proxy setting, since that only accounts for the CDN's own X-Forwarded-For.
function clientIp(req) {
  return req.headers['cf-connecting-ip'] || req.ip;
}

// Called from the embed player itself once real playback starts, and then
// periodically while it keeps playing. Public - viewers aren't logged in -
// so this only ever writes a play record, never reveals anything back about
// the channel. Skipped entirely for an admin session, since the dashboard's
// own live preview loads this exact same player - without this, checking on
// your own stream would count as a viewer and pollute the Stats history.
router.post('/track', (req, res) => {
  const isAdmin = !!(req.session && req.session.isAdmin);
  const channelId = req.body && req.body.channelId;
  if (!isAdmin && typeof channelId === 'string' && channelId) {
    plays.recordPlay({
      channelId,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] || '',
    });
  }
  res.status(204).end();
});

router.get('/', requireAuth, (req, res) => {
  const db = readDb();
  const channels = Object.values(db.channels)
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const rows = plays.listPlays({
    channelId: req.query.channelId || undefined,
    from: req.query.from || undefined,
    to: req.query.to || undefined,
  });

  res.json({ channels, plays: rows });
});

function csvField(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

router.get('/export.csv', requireAuth, (req, res) => {
  const rows = plays.listPlays({
    channelId: req.query.channelId || undefined,
    from: req.query.from || undefined,
    to: req.query.to || undefined,
  });

  const header = ['Latest Play', 'Channel', 'Title', 'Description', 'Type', 'IP Address', 'Country', 'Region', 'City', 'First Play'];
  const lines = [header.map(csvField).join(',')];
  rows.forEach((p) => {
    lines.push(
      [p.latestPlayAt, p.channelName, p.title, p.description, p.type, p.ip, p.country, p.region, p.city, p.firstPlayAt]
        .map(csvField)
        .join(',')
    );
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="stats.csv"');
  res.send(lines.join('\n'));
});

module.exports = router;
