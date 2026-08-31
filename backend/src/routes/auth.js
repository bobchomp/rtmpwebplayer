const express = require('express');
const crypto = require('crypto');

const router = express.Router();

const loginAttempts = new Map(); // ip -> { count, resetAt }
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function loginLimiter(req, res, next) {
  const ip = req.ip;
  const now = Date.now();

  // Opportunistic sweep - without this, an entry sticks around forever once
  // its window passes (every distinct IP that's ever hit this route, bots
  // and scanners included, would otherwise leak for the life of the
  // process). Cheap to do on every request since the map only holds IPs
  // active within the last WINDOW_MS.
  for (const [entryIp, entry] of loginAttempts) {
    if (now >= entry.resetAt) loginAttempts.delete(entryIp);
  }

  const rec = loginAttempts.get(ip);
  if (rec && now < rec.resetAt) {
    if (rec.count >= MAX_ATTEMPTS) {
      return res.status(429).json({ error: 'Too many attempts, try again later' });
    }
    rec.count += 1;
  } else {
    loginAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  }
  next();
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const validUser = process.env.ADMIN_USERNAME;
  const validPass = process.env.ADMIN_PASSWORD;

  if (!validUser || !validPass) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  if (
    typeof username === 'string' &&
    typeof password === 'string' &&
    safeEqual(username, validUser) &&
    safeEqual(password, validPass)
  ) {
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Login failed' });
      req.session.isAdmin = true;
      res.json({ ok: true });
    });
    return;
  }

  res.status(401).json({ error: 'Invalid credentials' });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.isAdmin) });
});

module.exports = router;
