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
    coverImages: [],
    activeCoverImage: null,
    liveThumbnails: [],
    activeLiveThumbnail: null,
    createdAt: new Date().toISOString(),
  };
  db.channels[id] = channel;
  writeDb(db);
  res.status(201).json(channel);
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

  res.json({
    id: channel.id,
    name: channel.name,
    isLive: channel.isLive,
    coverUrl: channel.activeCoverImage ? `/uploads/${channel.activeCoverImage}` : null,
    liveThumbnailUrl: channel.activeLiveThumbnail ? `/uploads/${channel.activeLiveThumbnail}` : null,
  });
});

module.exports = router;
