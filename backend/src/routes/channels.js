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
    coverImage: null,
    liveThumbnail: null,
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

  if (channel.coverImage) {
    const p = path.join(UPLOADS_DIR, channel.coverImage);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  if (channel.liveThumbnail) {
    const p = path.join(UPLOADS_DIR, channel.liveThumbnail);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
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

// Registers upload/remove routes for a channel image field (offline cover,
// live-pending thumbnail) - same validation and file-cleanup logic either way.
function registerImageRoutes(routeSegment, dbField) {
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

      if (ch[dbField]) {
        const old = path.join(UPLOADS_DIR, ch[dbField]);
        if (fs.existsSync(old)) fs.unlinkSync(old);
      }
      ch[dbField] = req.file.filename;
      writeDb(fresh);
      res.json(ch);
    });
  });

  router.delete(`/:id/${routeSegment}`, requireAuth, (req, res) => {
    const db = readDb();
    const channel = db.channels[req.params.id];
    if (!channel) return res.status(404).json({ error: 'Not found' });

    if (channel[dbField]) {
      const p = path.join(UPLOADS_DIR, channel[dbField]);
      if (fs.existsSync(p)) fs.unlinkSync(p);
      channel[dbField] = null;
      writeDb(db);
    }
    res.json(channel);
  });
}

// Admin: custom offline cover image (shown whenever the channel isn't live)
registerImageRoutes('cover', 'coverImage');
// Admin: custom live-pending thumbnail (shown once live, before the viewer presses play)
registerImageRoutes('live-thumbnail', 'liveThumbnail');

// Public: live status + cover, polled by the embed player. Never exposes the stream key.
router.get('/:id/status', (req, res) => {
  const db = readDb();
  const channel = db.channels[req.params.id];
  if (!channel) return res.status(404).json({ error: 'Not found' });

  res.json({
    id: channel.id,
    name: channel.name,
    isLive: channel.isLive,
    coverUrl: channel.coverImage ? `/uploads/${channel.coverImage}` : null,
    liveThumbnailUrl: channel.liveThumbnail ? `/uploads/${channel.liveThumbnail}` : null,
  });
});

module.exports = router;
