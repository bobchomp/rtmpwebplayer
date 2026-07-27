const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { readDb, writeDb } = require('../db');
const { requireAuth } = require('../authMiddleware');

const router = express.Router();
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${req.params.id}-${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) return cb(new Error('Unsupported file type'));
    cb(null, true);
  },
});

function generateStreamKey() {
  return crypto.randomBytes(20).toString('hex');
}

// Admin: list channels (includes stream keys, admin-only)
router.get('/', requireAuth, (req, res) => {
  const db = readDb();
  const channels = Object.values(db.channels).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  );
  res.json(channels);
});

// Admin: create a channel
router.post('/', requireAuth, (req, res) => {
  const name = ((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (name.length > 100) return res.status(400).json({ error: 'Name too long' });

  const db = readDb();
  const id = crypto.randomUUID();
  const channel = {
    id,
    name,
    streamKey: generateStreamKey(),
    isLive: false,
    lastLiveAt: null,
    // Shared across every output (embed page metadata + YouTube broadcast
    // title/description) - see the /:id/metadata route below.
    title: '',
    description: '',
    websiteEnabled: true,
    coverImages: [],
    activeCoverImage: null,
    liveThumbnails: [],
    activeLiveThumbnail: null,
    youtubeEnabled: false,
    youtubeBroadcastId: null,
    youtubeIngestAddress: null,
    youtubeStreamName: null,
    customOutputs: [],
    createdAt: new Date().toISOString(),
  };
  db.channels[id] = channel;
  writeDb(db);
  res.status(201).json(channel);
});

// Admin: fetch a single channel (includes stream key, admin-only)
router.get('/:id', requireAuth, (req, res) => {
  const db = readDb();
  const channel = db.channels[req.params.id];
  if (!channel) return res.status(404).json({ error: 'Not found' });
  res.json(channel);
});

// Admin: rename a channel
router.patch('/:id', requireAuth, (req, res) => {
  const name = ((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (name.length > 100) return res.status(400).json({ error: 'Name too long' });

  const db = readDb();
  const channel = db.channels[req.params.id];
  if (!channel) return res.status(404).json({ error: 'Not found' });

  channel.name = name;
  writeDb(db);
  res.json(channel);
});

// Admin: toggle whether the embed page / HLS proxy serve this channel at
// all. RTMP ingest and other outputs (YouTube, custom RTMP) are unaffected -
// this only gates the public-facing website/embed path.
router.patch('/:id/website-settings', requireAuth, (req, res) => {
  const db = readDb();
  const channel = db.channels[req.params.id];
  if (!channel) return res.status(404).json({ error: 'Not found' });

  if (typeof req.body.websiteEnabled === 'boolean') {
    channel.websiteEnabled = req.body.websiteEnabled;
  }
  writeDb(db);
  res.json(channel);
});

// Admin: update per-channel YouTube relay settings (currently just the toggle
// - title/description live on the shared /:id/metadata route below)
router.patch('/:id/youtube-settings', requireAuth, (req, res) => {
  const db = readDb();
  const channel = db.channels[req.params.id];
  if (!channel) return res.status(404).json({ error: 'Not found' });

  if (typeof req.body.youtubeEnabled === 'boolean') {
    channel.youtubeEnabled = req.body.youtubeEnabled;
  }
  writeDb(db);
  res.json(channel);
});

// Admin: update the shared title/description used both for the embed page's
// metadata (title tag, meta/OG description, on-screen overlay) and as the
// YouTube broadcast's title/description.
router.patch('/:id/metadata', requireAuth, (req, res) => {
  const db = readDb();
  const channel = db.channels[req.params.id];
  if (!channel) return res.status(404).json({ error: 'Not found' });

  if (typeof req.body.title === 'string') {
    if (req.body.title.length > 100) {
      return res.status(400).json({ error: 'Title too long' });
    }
    channel.title = req.body.title.trim();
  }
  if (typeof req.body.description === 'string') {
    if (req.body.description.length > 300) {
      return res.status(400).json({ error: 'Description too long' });
    }
    channel.description = req.body.description.trim();
  }
  writeDb(db);
  res.json(channel);
});

const MAX_CUSTOM_OUTPUTS = 10;

// The relay-targets endpoint emits tab/newline-delimited lines for the shell
// script to parse - reject those characters here so a pasted value can never
// break that format.
const HAS_CONTROL_CHARS = /[\t\r\n]/;

function validateOutputInput(body, { partial } = {}) {
  const errors = [];
  const update = {};

  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) errors.push('Name is required');
    if (name.length > 60) errors.push('Name too long');
    if (HAS_CONTROL_CHARS.test(name)) errors.push('Name contains invalid characters');
    update.name = name;
  }
  if (!partial || body.rtmpUrl !== undefined) {
    const rtmpUrl = String(body.rtmpUrl || '').trim().replace(/\/+$/, '');
    if (!/^rtmps?:\/\/.+/i.test(rtmpUrl)) errors.push('RTMP URL must start with rtmp:// or rtmps://');
    if (HAS_CONTROL_CHARS.test(rtmpUrl)) errors.push('RTMP URL contains invalid characters');
    update.rtmpUrl = rtmpUrl;
  }
  if (!partial || body.streamKey !== undefined) {
    const streamKey = String(body.streamKey || '').trim();
    if (!streamKey) errors.push('Stream key is required');
    if (HAS_CONTROL_CHARS.test(streamKey)) errors.push('Stream key contains invalid characters');
    update.streamKey = streamKey;
  }
  if (typeof body.enabled === 'boolean') update.enabled = body.enabled;

  return { errors, update };
}

// Admin: add a custom RTMP output (e.g. Twitch, Facebook, another server) -
// relayed to automatically while live, same mechanism as the YouTube relay.
router.post('/:id/outputs', requireAuth, (req, res) => {
  const db = readDb();
  const channel = db.channels[req.params.id];
  if (!channel) return res.status(404).json({ error: 'Not found' });

  channel.customOutputs = channel.customOutputs || [];
  if (channel.customOutputs.length >= MAX_CUSTOM_OUTPUTS) {
    return res.status(400).json({ error: `Maximum of ${MAX_CUSTOM_OUTPUTS} custom outputs per channel` });
  }

  const { errors, update } = validateOutputInput(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors.join(', ') });

  const output = {
    id: crypto.randomUUID(),
    name: update.name,
    rtmpUrl: update.rtmpUrl,
    streamKey: update.streamKey,
    enabled: update.enabled !== undefined ? update.enabled : true,
  };
  channel.customOutputs.push(output);
  writeDb(db);
  res.status(201).json(channel);
});

// Admin: update a custom RTMP output (name, URL, key, and/or on/off)
router.patch('/:id/outputs/:outputId', requireAuth, (req, res) => {
  const db = readDb();
  const channel = db.channels[req.params.id];
  if (!channel) return res.status(404).json({ error: 'Not found' });

  const output = (channel.customOutputs || []).find((o) => o.id === req.params.outputId);
  if (!output) return res.status(404).json({ error: 'Output not found' });

  const { errors, update } = validateOutputInput(req.body || {}, { partial: true });
  if (errors.length) return res.status(400).json({ error: errors.join(', ') });

  Object.assign(output, update);
  writeDb(db);
  res.json(channel);
});

// Admin: remove a custom RTMP output
router.delete('/:id/outputs/:outputId', requireAuth, (req, res) => {
  const db = readDb();
  const channel = db.channels[req.params.id];
  if (!channel) return res.status(404).json({ error: 'Not found' });

  const before = (channel.customOutputs || []).length;
  channel.customOutputs = (channel.customOutputs || []).filter((o) => o.id !== req.params.outputId);
  if (channel.customOutputs.length === before) return res.status(404).json({ error: 'Output not found' });

  writeDb(db);
  res.json(channel);
});

// Admin: delete a channel
router.delete('/:id', requireAuth, (req, res) => {
  const db = readDb();
  const channel = db.channels[req.params.id];
  if (!channel) return res.status(404).json({ error: 'Not found' });

  (channel.coverImages || []).concat(channel.liveThumbnails || []).forEach((filename) => {
    const p = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
  delete db.channels[req.params.id];
  writeDb(db);
  res.json({ ok: true });
});

// Admin: rotate the stream key (invalidates the old one immediately)
router.post('/:id/regenerate-key', requireAuth, (req, res) => {
  const db = readDb();
  const channel = db.channels[req.params.id];
  if (!channel) return res.status(404).json({ error: 'Not found' });

  channel.streamKey = generateStreamKey();
  channel.isLive = false;
  writeDb(db);
  res.json(channel);
});

// Registers upload/list/delete/activate routes for a channel image gallery
// (offline covers, live-pending thumbnails) - each is a list of uploaded
// images plus a pointer to the one currently in use.
function registerGalleryRoutes(routeSegment, listField, activeField) {
  // Upload a new image into the gallery. The first image ever uploaded
  // becomes active automatically; later ones are just added to the list
  // until explicitly activated.
  router.post(`/:id/${routeSegment}`, requireAuth, (req, res) => {
    const db = readDb();
    const channel = db.channels[req.params.id];
    if (!channel) return res.status(404).json({ error: 'Not found' });

    upload.single('image')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const fresh = readDb();
      const ch = fresh.channels[req.params.id];
      if (!ch) {
        fs.unlinkSync(path.join(UPLOADS_DIR, req.file.filename));
        return res.status(404).json({ error: 'Not found' });
      }

      ch[listField] = ch[listField] || [];
      ch[listField].push(req.file.filename);
      if (!ch[activeField]) ch[activeField] = req.file.filename;
      writeDb(fresh);
      res.json(ch);
    });
  });

  // Remove one image from the gallery. If it was active, falls back to no
  // active image (the player's own default-placeholder chain takes over).
  router.delete(`/:id/${routeSegment}/:filename`, requireAuth, (req, res) => {
    const db = readDb();
    const channel = db.channels[req.params.id];
    if (!channel) return res.status(404).json({ error: 'Not found' });

    const filename = req.params.filename;
    const list = channel[listField] || [];
    if (!list.includes(filename)) return res.status(404).json({ error: 'Image not found' });

    channel[listField] = list.filter((f) => f !== filename);
    if (channel[activeField] === filename) channel[activeField] = null;

    const p = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);

    writeDb(db);
    res.json(channel);
  });

  // Set which image in the gallery is currently in use.
  router.post(`/:id/${routeSegment}/:filename/activate`, requireAuth, (req, res) => {
    const db = readDb();
    const channel = db.channels[req.params.id];
    if (!channel) return res.status(404).json({ error: 'Not found' });

    const filename = req.params.filename;
    if (!(channel[listField] || []).includes(filename)) {
      return res.status(404).json({ error: 'Image not found' });
    }

    channel[activeField] = filename;
    writeDb(db);
    res.json(channel);
  });
}

// Admin: offline cover gallery (shown whenever the channel isn't live)
registerGalleryRoutes('covers', 'coverImages', 'activeCoverImage');
// Admin: live-pending thumbnail gallery (shown once live, before play is pressed)
registerGalleryRoutes('live-thumbnails', 'liveThumbnails', 'activeLiveThumbnail');

// Public: live status + cover, polled by the embed player. Never exposes the stream key.
router.get('/:id/status', (req, res) => {
  const db = readDb();
  const channel = db.channels[req.params.id];
  if (!channel) return res.status(404).json({ error: 'Not found' });

  // The client's fetch() cache:'no-store' option only governs the browser's
  // own cache - it does nothing to stop an intermediary (CDN) from caching
  // this response if some other rule ever ends up matching /api/ paths, so
  // this needs to be explicit here too.
  res.set('Cache-Control', 'no-store');
  res.json({
    id: channel.id,
    name: channel.name,
    isLive: channel.isLive,
    lastLiveAt: channel.lastLiveAt,
    coverUrl: channel.activeCoverImage ? `/uploads/${channel.activeCoverImage}` : null,
    liveThumbnailUrl: channel.activeLiveThumbnail ? `/uploads/${channel.activeLiveThumbnail}` : null,
  });
});

module.exports = router;
