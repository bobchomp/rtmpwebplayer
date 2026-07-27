const express = require('express');
const { Readable } = require('stream');
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
    // "no-cache" alone permits a cache to store this and revalidate later -
    // but there's no ETag/Last-Modified here to revalidate against, so an
    // intermediate cache (CDN or browser) could end up just treating a
    // stored copy as good indefinitely. "no-store" leaves no ambiguity: the
    // live playlist must never be served from any cache - it's tiny and
    // needs to reflect the real live edge on every single request.
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'no-store');

    // The actual video segments (below) ARE safe to cache at the CDN, which
    // is what actually matters for handling a lot of concurrent viewers -
    // but nginx numbers segment files per-stream-key (0.ts, 1.ts, ...), and
    // those filenames get reused every time a new broadcast starts on the
    // same channel. Tagging each segment reference in the manifest with this
    // broadcast's start time makes every session's segment URLs unique, so a
    // CDN can cache them for a long time with zero risk of ever serving a
    // stale one from a previous, unrelated stream.
    const token = encodeURIComponent(channel.lastLiveAt || '');
    const text = await upstream.text();
    const rewritten = text
      .split('\n')
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        return token ? trimmed + '?s=' + token : trimmed;
      })
      .join('\n');
    return res.send(rewritten);
  }

  if (file.endsWith('.ts')) {
    res.set('Content-Type', 'video/mp2t');
    // Safe to cache for a long time now that each broadcast's segment URLs
    // are unique (see the manifest rewrite above) - a segment's bytes never
    // change once nginx finishes writing it, and an old URL simply never
    // gets requested again once its broadcast ends.
    res.set('Cache-Control', 'public, max-age=86400, immutable');
  }

  // Stream the response through rather than buffering the whole segment (up
  // to a couple of MB each) into memory first - matters once many viewers
  // are being served at once, especially on a small droplet.
  const upstreamStream = Readable.fromWeb(upstream.body);
  upstreamStream.on('error', () => {
    if (!res.headersSent) res.status(502);
    res.end();
  });
  upstreamStream.pipe(res);
});

module.exports = router;
