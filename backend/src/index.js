require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const authRoutes = require('./routes/auth');
const channelRoutes = require('./routes/channels');
const rtmpHooks = require('./routes/rtmpHooks');
const hlsProxy = require('./routes/hlsProxy');
const embed = require('./routes/embed');
const youtubeAuth = require('./routes/youtubeAuth');
const statsRoutes = require('./routes/stats');
const geoip = require('./geoip');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // nginx-rtmp posts form-encoded webhooks

app.use(
  session({
    name: 'rwp.sid',
    secret: process.env.SESSION_SECRET || 'change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // 'auto' marks the cookie secure only when the request is actually HTTPS
      // (directly, or via trust-proxied X-Forwarded-Proto from Caddy).
      secure: 'auto',
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  })
);

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOADS_DIR));

app.get('/healthz', (req, res) => res.send('ok'));

app.get('/api/config', (req, res) => {
  res.json({
    publicHost: process.env.PUBLIC_HOST || req.hostname,
    // Separate from publicHost: if you're behind a CDN proxy (e.g. Cloudflare)
    // that doesn't forward the RTMP port, set this to your server's raw IP
    // (or an unproxied hostname) so the dashboard shows a working RTMP URL.
    rtmpHost: process.env.RTMP_PUBLIC_HOST || process.env.PUBLIC_HOST || req.hostname,
    rtmpPort: process.env.RTMP_PORT || 1935,
  });
});

app.use('/api', authRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/rtmp', rtmpHooks);
app.use('/api/youtube', youtubeAuth);
app.use('/api/stats', statsRoutes);
app.use('/live', hlsProxy);
app.use('/embed', embed);

app.use(express.static(path.join(__dirname, 'public')));

geoip.ensureDatabase();

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend listening on :${PORT}`));
