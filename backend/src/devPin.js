const crypto = require('crypto');
const { IS_DEV_SITE, withDevBanner } = require('./devBanner');
const { secretMatches } = require('./safeCompare');

// Locks the whole dev site behind a PIN (DEV_SITE_PIN in the dev .env), so
// only people who've been given it can see work in progress. Production
// never has IS_DEV_SITE set, so this is a no-op there even if the variable
// is. Sits in front of everything, Auth0 login included.
const PIN = IS_DEV_SITE ? process.env.DEV_SITE_PIN || '' : '';

const COOKIE_NAME = 'rwp.devpin';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

// Paths that must work without the PIN: nginx-rtmp's webhooks (called by the
// dev-rtmp container, never a browser - Caddy already blocks them from
// outside), health checks, and the files the PIN page itself needs.
const EXEMPT_PREFIXES = ['/api/rtmp/', '/healthz', '/style.css', '/fonts/', '/favicon.'];

// Derived from the PIN and SESSION_SECRET rather than storing the PIN in the
// cookie, so the cookie can't be forged and changing the PIN logs everyone out.
function expectedCookieValue() {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(`dev-site-pin:${PIN}`).digest('hex');
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return '';
}

// A 4-digit PIN is only 10,000 guesses, so each IP gets MAX_FAILURES wrong
// tries before being locked out for LOCKOUT_MS.
const failures = new Map();

function lockedOut(ip) {
  const entry = failures.get(ip);
  return entry && entry.lockedUntil > Date.now();
}

function recordFailure(ip) {
  const now = Date.now();
  for (const [key, entry] of failures) {
    if (entry.lockedUntil && entry.lockedUntil <= now) failures.delete(key);
  }
  const entry = failures.get(ip) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_FAILURES) {
    entry.count = 0;
    entry.lockedUntil = now + LOCKOUT_MS;
  }
  failures.set(ip, entry);
}

// Only same-site paths, so the form can't be used as an open redirect.
function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')
    ? next
    : '/';
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function pinPage(next, error) {
  return withDevBanner(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Enter PIN - RTMP Web Player</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.png" type="image/png">
<link rel="stylesheet" href="/style.css">
<style>
  .pin-input { font: 600 22px/1.2 var(--font-display); letter-spacing: .4em; text-align: center; }
  .login-box h1 { margin: 0; font: 600 20px/1.3 var(--font-display); }
  .login-box button { padding: 11px 15px; }
</style>
</head>
<body>
<form class="login-box" method="post" action="/dev-pin">
  <h1>Development site</h1>
  <p class="hint" style="margin:0">Enter the PIN to continue.</p>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
  <label>PIN
    <input class="pin-input" type="password" name="pin" inputmode="numeric" autocomplete="off" autofocus required>
  </label>
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <button type="submit">Continue</button>
</form>
</body>
</html>`);
}

function sendPinPage(res, status, next, error) {
  res.status(status).type('html').set('Cache-Control', 'no-store').send(pinPage(next, error));
}

function devPinGate(req, res, next) {
  if (!PIN) return next();

  if (req.method === 'POST' && req.path === '/dev-pin') {
    const target = safeNext(req.body && req.body.next);
    if (lockedOut(req.ip)) {
      return sendPinPage(res, 429, target, 'Too many wrong PINs. Try again in 15 minutes.');
    }
    if (!secretMatches(String((req.body && req.body.pin) || ''), PIN)) {
      recordFailure(req.ip);
      return sendPinPage(res, 401, target, lockedOut(req.ip) ? 'Too many wrong PINs. Try again in 15 minutes.' : 'Wrong PIN.');
    }
    failures.delete(req.ip);
    const secure = req.secure ? '; Secure' : '';
    res.set('Set-Cookie', `${COOKIE_NAME}=${expectedCookieValue()}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure}`);
    return res.redirect(303, target);
  }

  if (EXEMPT_PREFIXES.some((prefix) => req.path.startsWith(prefix))) return next();
  if (secretMatches(readCookie(req, COOKIE_NAME), expectedCookieValue())) return next();

  sendPinPage(res, 401, req.method === 'GET' ? safeNext(req.originalUrl) : '/');
}

module.exports = { devPinGate };
