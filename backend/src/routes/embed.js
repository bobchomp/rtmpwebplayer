const express = require('express');

const { readDb } = require('../db');
const { frameAncestorsHeader, isDirectNavigation } = require('../embedSecurity');
const { buildPlayerHtml } = require('../playerPage');
const { ownsChannel } = require('../accounts');

// Shown in place of the player when "Your Website" is switched off - a clear
// message rather than a blank or broken player, so whoever looks at the
// website can tell why. (A silent 404 here once caused a confused
// "stream is not available" report.)
const WEBSITE_OFF_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Livestream unavailable</title>
<style>html,body{margin:0;height:100%;background:#22262B;color:#FAF9F6;font:500 16px/1.5 -apple-system,'Segoe UI',Roboto,sans-serif}
body{display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;box-sizing:border-box}</style>
</head><body><p>The livestream isn't available here right now.</p></body></html>`;

const router = express.Router();

router.get('/:channelId', (req, res) => {
  const db = readDb();
  const channel = db.channels[req.params.channelId];
  if (!channel) return res.status(404).send('Channel not found');

  const isAdmin = !!(req.session && req.session.isAdmin);
  const isOwner = ownsChannel(channel, req.session && req.session.account);

  // This page is meant to live inside an iframe on an approved site, not to
  // be opened directly - just refuse, rather than redirecting to the Public
  // Link output (if this channel has one) - that link is something you hand
  // out deliberately, not something a blocked embed visit should ever expose
  // on your behalf. Admin exempted so you can still open it directly
  // yourself to check on things.
  if (isDirectNavigation(req) && !isAdmin) {
    return res.status(403).send('Access denied.');
  }

  // Controls which sites may frame this page at all - see ALLOWED_EMBED_DOMAINS.
  res.set('Content-Security-Policy', frameAncestorsHeader());
  // Without this, a browser (or the CDN) could serve a stale cached copy of
  // this page's script indefinitely - e.g. the dashboard's own live-preview
  // iframe, left open across many deploys, silently running old player code
  // until someone thought to manually clear site data.
  res.set('Cache-Control', 'no-store');
  // "Your Website" switched off: visitors get a message, while the owner
  // still sees the player (the dashboard's preview uses this same page).
  if (channel.embedEnabled === false && !isOwner) return res.type('html').send(WEBSITE_OFF_HTML);
  res.type('html').send(buildPlayerHtml(channel));
});

module.exports = router;
