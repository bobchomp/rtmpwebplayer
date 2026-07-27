const express = require('express');
const path = require('path');
const fs = require('fs');

const { readDb } = require('../db');
const { frameAncestorsHeader } = require('../embedSecurity');

const router = express.Router();
const TEMPLATE = fs.readFileSync(
  path.join(__dirname, '..', 'views', 'embed.html'),
  'utf8'
);

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

// Safely embeds a value as a JS string literal inside an inline <script>
// block. JSON.stringify handles JS-string escaping (quotes, backslashes,
// newlines) and also supplies the surrounding quotes; escaping "<"/">" on
// top of that stops a title/description containing something like
// "</script><script>..." from prematurely closing the script block itself.
function escapeForInlineScript(str) {
  return JSON.stringify(String(str)).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

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

  const displayTitle = channel.title || channel.name;
  const description = channel.description || '';

  const html = TEMPLATE
    .replace(/__CHANNEL_ID__/g, channel.id)
    .replace(/__CHANNEL_NAME__/g, escapeHtml(channel.name))
    .replace(/__PAGE_TITLE__/g, escapeHtml(displayTitle))
    .replace(/__META_DESCRIPTION__/g, escapeHtml(description))
    .replace(/__TITLE_JSON__/g, escapeForInlineScript(channel.title || ''))
    .replace(/__DESCRIPTION_JSON__/g, escapeForInlineScript(description));

  // Controls which sites may frame this page at all - see ALLOWED_EMBED_DOMAINS.
  res.set('Content-Security-Policy', frameAncestorsHeader());
  // Without this, a browser (or the CDN) could serve a stale cached copy of
  // this page's script indefinitely - e.g. the dashboard's own live-preview
  // iframe, left open across many deploys, silently running old player code
  // until someone thought to manually clear site data.
  res.set('Cache-Control', 'no-store');
  res.type('html').send(html);
});

module.exports = router;
