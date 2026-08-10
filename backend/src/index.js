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
const watch = require('./routes/watch');
const youtubeAuth = require('./routes/youtubeAuth');
const statsRoutes = require('./routes/stats');
const geoip = require('./geoip');
const { renderStatusPage } = require('./statusPage');
const { requireAuth } = require('./authMiddleware');
const { IS_DEV_SITE, withDevBanner, stripDevSiteLinkOnDevSite, stripStatusLinkOnDevSite, stripYoutubeOnProduction } = require('./devBanner');

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
    // YouTube relaying is a dev-site-only feature by design (see
    // /api/youtube below, only mounted here too) - gated on IS_DEV_SITE
    // itself, not just credential presence, so it stays off on production
    // even if GOOGLE_CLIENT_ID/SECRET were ever accidentally set there.
    youtubeEnabled: IS_DEV_SITE && !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  });
});

// Admin-only download of scripts/load-test.js (see the Stream Test dashboard
// page) - not under express.static, so it's never reachable without a login.
app.get('/api/tools/load-test.js', requireAuth, (req, res) => {
  res.download(path.join(__dirname, 'downloads', 'load-test.js'), 'load-test.js');
});

app.use('/api', authRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/rtmp', rtmpHooks);
// Dev-site-only (see stripYoutubeOnProduction below and rtmpHooks.js) - not
// mounted at all on production, so a request to any /api/youtube/* route
// there gets a plain 404 rather than revealing the route exists.
if (IS_DEV_SITE) app.use('/api/youtube', youtubeAuth);
app.use('/api/stats', statsRoutes);
app.use('/live', hlsProxy);
app.use('/embed', embed);
app.use('/watch', watch);

const PUBLIC_DIR = path.join(__dirname, 'public');

// Loaded (and, on the dev stack, banner-injected) once at startup rather than
// per-request - none of this changes while the process is running.
function loadHtmlPage(filename) {
  return stripYoutubeOnProduction(withDevBanner(fs.readFileSync(path.join(PUBLIC_DIR, filename), 'utf8')));
}

const homepageHtml = stripStatusLinkOnDevSite(stripDevSiteLinkOnDevSite(loadHtmlPage('index.html')));
const dashboardHtml = stripStatusLinkOnDevSite(loadHtmlPage('dashboard.html'));
const loginHtml = loadHtmlPage('login.html');
const privacyHtml = loadHtmlPage('privacy.html');

app.get('/', (req, res) => res.type('html').send(homepageHtml));

// The admin dashboard lives at its own path (not '/') so the site's actual
// homepage can be a genuine public page describing the app - required by
// Google's OAuth branding verification, which flags a homepage that's
// nothing but a login form. The login form itself lives at yet another path
// (not folded into the dashboard) so it's a real page of its own rather than
// a view swapped in by client-side JS.
app.get(['/dashboard', '/dashboard/'], (req, res) => res.type('html').send(dashboardHtml));

app.get(['/login', '/login/'], (req, res) => res.type('html').send(loginHtml));

app.get('/privacy.html', (req, res) => res.type('html').send(privacyHtml));

// Production-only - it reports on production's own endpoints specifically
// (see bobchomp/rtmpwebplayer-status), so showing it on the dev site would
// just be confusing (a dev visitor would see production's status, not
// anything about the stack they're actually looking at).
if (!IS_DEV_SITE) {
  app.get('/status', async (req, res) => {
    res.type('html').send(await renderStatusPage());
  });
}

app.use(express.static(PUBLIC_DIR));

geoip.ensureDatabase();

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend listening on :${PORT}`));
