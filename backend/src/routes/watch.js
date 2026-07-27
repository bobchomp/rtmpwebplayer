const express = require('express');
const crypto = require('crypto');

const { readDb } = require('../db');
const { buildPlayerHtml } = require('../playerPage');

const router = express.Router();

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// A direct, shareable link to a channel's stream (for pasting into
// WhatsApp/Facebook/email/etc) - separate from the /embed route, which is
// meant to be iframed on your own site. This one is deliberately the
// opposite: it refuses to render inside anyone else's iframe at all, so it
// can't be passed off as someone else's embedded content.
//
// The channel id in the URL isn't a secret on its own - it's the same id
// already visible in the embed code - so this also requires a random token
// nobody could guess just by taking that embed link and swapping the path.
// Every failure case (missing channel, no public-link output, disabled, or
// wrong token) returns the same generic 404, rather than a more specific
// "wrong code" response that would confirm a channel/output exists at all.
router.get('/:channelId/:token', (req, res) => {
  const db = readDb();
  const channel = db.channels[req.params.channelId];
  if (!channel) return res.status(404).send('This stream is not available here.');

  const output = (channel.outputs || []).find((o) => o.type === 'public-link');
  if (!output || !output.enabled || !output.token || !safeEqual(req.params.token, output.token)) {
    return res.status(404).send('This stream is not available here.');
  }

  // Belt-and-braces: X-Frame-Options is the older, universally-honored
  // header; the CSP frame-ancestors directive is the modern equivalent that
  // takes precedence where both are understood. Together they stop this
  // page rendering inside an <iframe> anywhere, including on this app's own
  // origin - unlike the embed route, this link isn't meant to be framed at all.
  res.set('X-Frame-Options', 'DENY');
  res.set('Content-Security-Policy', "frame-ancestors 'none'");
  res.set('Cache-Control', 'no-store');
  res.type('html').send(buildPlayerHtml(channel));
});

module.exports = router;
