const express = require('express');
const path = require('path');
const fs = require('fs');

const { readDb } = require('../db');

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

router.get('/:channelId', (req, res) => {
  const db = readDb();
  const channel = db.channels[req.params.channelId];
  if (!channel) return res.status(404).send('Channel not found');

  const html = TEMPLATE.replace(/__CHANNEL_ID__/g, channel.id).replace(
    /__CHANNEL_NAME__/g,
    escapeHtml(channel.name)
  );

  // Explicitly allow this page to be framed on any site - it's meant to be embedded.
  res.set('Content-Security-Policy', 'frame-ancestors *');
  res.type('html').send(html);
});

module.exports = router;
