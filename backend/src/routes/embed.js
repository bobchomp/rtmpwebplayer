const express = require('express');

const { readDb } = require('../db');
const { frameAncestorsHeader, isDirectNavigation } = require('../embedSecurity');
const { buildPlayerHtml } = require('../playerPage');

const router = express.Router();

router.get('/:channelId', (req, res) => {
  const db = readDb();
  const channel = db.channels[req.params.channelId];
  if (!channel) return res.status(404).send('Channel not found');

  // Turning "Your Website" off only blocks public visitors - the dashboard's
  // own live preview reuses this same route and should keep working for you.
  const isAdmin = !!(req.session && req.session.isAdmin);
  if (!channel.websiteEnabled && !isAdmin) {
    return res.status(404).send('This stream is not available here.');
  }

  // This page is meant to live inside an iframe on an approved site, not to
  // be opened directly - send a direct visit somewhere that's actually built
  // for that instead of rendering the bare player. Admin exempted so you can
  // still open it directly yourself to check on things.
  if (isDirectNavigation(req) && !isAdmin) {
    const publicLink = (channel.outputs || []).find((o) => o.type === 'public-link' && o.enabled);
    if (publicLink) return res.redirect('/watch/' + channel.id);
    return res.status(403).send('This stream can only be viewed on an approved website.');
  }

  // Controls which sites may frame this page at all - see ALLOWED_EMBED_DOMAINS.
  res.set('Content-Security-Policy', frameAncestorsHeader());
  // Without this, a browser (or the CDN) could serve a stale cached copy of
  // this page's script indefinitely - e.g. the dashboard's own live-preview
  // iframe, left open across many deploys, silently running old player code
  // until someone thought to manually clear site data.
  res.set('Cache-Control', 'no-store');
  res.type('html').send(buildPlayerHtml(channel));
});

module.exports = router;
