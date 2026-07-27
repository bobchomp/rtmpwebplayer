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

// A YouTube-type output carries an OAuth refresh token (a server-to-Google
// credential with no legitimate reason to reach the browser) - every route
// that serializes a channel goes through this first to strip it out.
function redactChannel(channel) {
  if (!channel.outputs || !channel.outputs.some((o) => o.refreshToken)) return channel;
  return Object.assign({}, channel, {
    outputs: channel.outputs.map((o) => {
      if (!o.refreshToken) return o;
      const { refreshToken, ...safe } = o;
      return safe;
    }),
  });
}

// Admin: list channels (includes stream keys, admin-only)
router.get('/', requireAuth, (req, res) => {
  const db = readDb();
  const channels = Object.values(db.channels).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  );
  res.json(channels.map(redactChannel));
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
    // Every relay destination (YouTube, custom RTMP, and future types) lives
    // in this one array, distinguished by `type` - see validateOutputInput
    // below for 'rtmp' outputs and youtube.js's handleOAuthCallback for how
    // 'youtube' outputs get added (through the OAuth flow, not this array
    // being posted to directly).
    outputs: [],
    createdAt: new Date().toISOString(),
  };
  db.channels[id] = channel;
  writeDb(db);
  res.status(201).json(redactChannel(channel));
});

// Admin: fetch a single channel (includes stream key, admin-only)
router.get('/:id', requireAuth, (req, res) => {
  const db = readDb();
  const channel = db.channels[req.params.id];
  if (!channel) return res.status(404).json({ error: 'Not found' });
  res.json(redactChannel(channel));
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
  res.json(redactChannel(channel));
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
  res.json(redactChannel(channel));
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
  res.json(redactChannel(channel));
});

const MAX_OUTPUTS = 10;

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

// Admin: add an output. Most fields depend on type:
// - 'rtmp': a custom RTMP destination (e.g. Twitch, Facebook, another
//   server) - relayed to automatically while live, name/URL/key required.
// - 'public-link': a direct, non-embeddable watch link for this channel (see
//   routes/watch.js) - no fields needed beyond the type itself, and a
//   channel can only have one (there's nothing to differentiate a second
//   one - it'd point at the exact same URL).
// (YouTube outputs are added via the OAuth flow in youtubeAuth.js/youtube.js,
// not through this route, since they need a Google sign-in redirect rather
// than a plain form submission.)
router.post('/:id/outputs', requireAuth, (req, res) => {
  const db = readDb();
  const channel = db.channels[req.params.id];
  if (!channel) return res.status(404).json({ error: 'Not found' });

  channel.outputs = channel.outputs || [];
  if (channel.outputs.length >= MAX_OUTPUTS) {
    return res.status(400).json({ error: `Maximum of ${MAX_OUTPUTS} outputs per channel` });
  }

  if (req.body && req.body.type === 'public-link') {
    if (channel.outputs.some((o) => o.type === 'public-link')) {
      return res.status(400).json({ error: 'This channel already has a public link' });
    }
    const output = { id: crypto.randomUUID(), type: 'public-link', enabled: true };
    channel.outputs.push(output);
    writeDb(db);
    return res.status(201).json(redactChannel(channel));
  }

  const { errors, update } = validateOutputInput(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors.join(', ') });

  const output = {
    id: crypto.randomUUID(),
    type: 'rtmp',
    name: update.name,
    rtmpUrl: update.rtmpUrl,
    streamKey: update.streamKey,
    enabled: update.enabled !== undefined ? update.enabled : true,
  };
  channel.outputs.push(output);
  writeDb(db);
  res.status(201).json(redactChannel(channel));
});

// Admin: update an output. RTMP outputs can have their name/URL/key edited;
// a YouTube or public-link output can only be switched on/off here (there's
// nothing else about either of those a form could meaningfully edit).
router.patch('/:id/outputs/:outputId', requireAuth, (req, res) => {
  const db = readDb();
  const channel = db.channels[req.params.id];
  if (!channel) return res.status(404).json({ error: 'Not found' });

  const output = (channel.outputs || []).find((o) => o.id === req.params.outputId);
  if (!output) return res.status(404).json({ error: 'Output not found' });

  if (output.type === 'youtube' || output.type === 'public-link') {
    if (typeof req.body.enabled === 'boolean') output.enabled = req.body.enabled;
    writeDb(db);
    return res.json(redactChannel(channel));
  }

  const { errors, update } = validateOutputInput(req.body || {}, { partial: true });
  if (errors.length) return res.status(400).json({ error: errors.join(', ') });

  Object.assign(output, update);
  writeDb(db);
  res.json(redactChannel(channel));
});

// Admin: remove an output (for a YouTube output, this also disconnects it -
// see youtubeAuth.js's disconnect route, which does the same thing).
router.delete('/:id/outputs/:outputId', requireAuth, (req, res) => {
  const db = readDb();
  const channel = db.channels[req.params.id];
  if (!channel) return res.status(404).json({ error: 'Not found' });

  const before = (channel.outputs || []).length;
  channel.outputs = (channel.outputs || []).filter((o) => o.id !== req.params.outputId);
  if (channel.outputs.length === before) return res.status(404).json({ error: 'Output not found' });

  writeDb(db);
  res.json(redactChannel(channel));
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
  res.json(redactChannel(channel));
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
    res.json(redactChannel(channel));
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
    res.json(redactChannel(channel));
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
