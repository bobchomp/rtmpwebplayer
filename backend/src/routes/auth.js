const express = require('express');
const crypto = require('crypto');

const router = express.Router();

const loginAttempts = new Map(); // ip -> { count, resetAt }
// Throttling by IP alone doesn't stop an attacker who just rotates through
// proxies/IPs while sticking to the same guessed username - tracking the
// attempted username too catches that, since it's the one thing that stays
// constant across rotated IPs. Keyed on the raw attempted value, not
// whether it's actually correct - this is purely attempt-counting, not
// authentication.
const usernameAttempts = new Map(); // lowercased username -> { count, resetAt }
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
// Caps how much of a bogus "username" value (an attacker could send
// anything in that field) gets used as a map key, so a flood of huge
// strings can't be used to inflate memory use.
const MAX_USERNAME_KEY_LENGTH = 100;

// Opportunistic sweep - without this, an entry sticks around forever once
// its window passes (every distinct IP or attempted username, bots and
// scanners included, would otherwise leak for the life of the process).
// Cheap to do on every request since each map only holds keys active
// within the last WINDOW_MS.
function pruneExpired(map, now) {
  for (const [key, entry] of map) {
    if (now >= entry.resetAt) map.delete(key);
  }
}

// Returns false (and leaves the counter untouched) once a key is already at
// the limit, otherwise records this attempt and returns true.
function checkAndCount(map, key, now) {
  const rec = map.get(key);
  if (rec && now < rec.resetAt) {
    if (rec.count >= MAX_ATTEMPTS) return false;
    rec.count += 1;
  } else {
    map.set(key, { count: 1, resetAt: now + WINDOW_MS });
  }
  return true;
}

function loginLimiter(req, res, next) {
  const now = Date.now();
  pruneExpired(loginAttempts, now);
  pruneExpired(usernameAttempts, now);

  const ip = req.ip;
  const rawUsername = req.body && typeof req.body.username === 'string' ? req.body.username : '';
  const usernameKey = rawUsername.trim().toLowerCase().slice(0, MAX_USERNAME_KEY_LENGTH);

  const ipOk = checkAndCount(loginAttempts, ip, now);
  // No username submitted at all isn't something worth throttling on its
  // own - the IP-based check already covers that request.
  const usernameOk = usernameKey ? checkAndCount(usernameAttempts, usernameKey, now) : true;

  if (!ipOk || !usernameOk) {
    return res.status(429).json({ error: 'Too many attempts, try again later' });
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
