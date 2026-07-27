const express = require('express');
const { readDb } = require('../db');
const { isRefererAllowed } = require('../embedSecurity');

const router = express.Router();
const HLS_INTERNAL_URL = process.env.HLS_INTERNAL_URL || 'http://rtmp:8080';

// Public HLS playback, addressed by the channel's public id — never the secret
// stream key. This proxies to the rtmp container's internal-only HTTP port,
// which is keyed by stream key but is never reachable from outside the
// docker network, so the key never reaches a viewer's browser.
router.get('/:channelId/:file', async (req, res) => {
  const { channelId, file } = req.params;

  if (!/^[a-zA-Z0-9_.-]+$/.test(file)) return res.status(400).send('Bad request');

  // Stops someone bypassing the iframe entirely by hotlinking these URLs
  // into their own player on another site - see ALLOWED_EMBED_DOMAINS.
  if (!isRefererAllowed(req)) return res.status(403).send('Forbidden');

  const db = readDb();
  const channel = db.channels[channelId];
  if (!channel) return res.status(404).send('Not found');

  // Same admin exception as embed.js - so the dashboard's own preview still
  // works even when the public embed is switched off.
  const isAdmin = !!(req.session && req.session.isAdmin);
  if (!channel.websiteEnabled && !isAdmin) return res.status(404).send('Not found');

  const target = `${HLS_INTERNAL_URL}/hls/${channel.streamKey}/${file}`;

  let upstream;
  try {
    upstream = await fetch(target);
  } catch (err) {
    return res.status(502).send('Upstream error');
  }

  if (!upstream.ok) return res.status(upstream.status).send();

  res.set('Access-Control-Allow-Origin', '*');
  if (file.endsWith('.m3u8')) {
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    // "no-cache" alone permits a cache to store this and revalidate later -
    // but there's no ETag/Last-Modified here to revalidate against, so an
    // intermediate cache (CDN or browser) could end up just treating a
    // stored copy as good indefinitely. "no-store" leaves no ambiguity: the
    // live playlist must never be served from any cache.
    res.set('Cache-Control', 'no-store');
  } else if (file.endsWith('.ts')) {
    res.set('Content-Type', 'video/mp2t');
    res.set('Cache-Control', 'public, max-age=5');
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  res.send(buf);
});

module.exports = router;
