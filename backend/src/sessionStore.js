// Login sessions, kept in memory and mirrored to data/sessions.json so they
// survive a deploy/restart (express-session's default MemoryStore loses them,
// and never prunes expired ones, so anyone hitting /auth/login could grow it
// without bound). Expired sessions are pruned on a timer, and the total is
// capped as a backstop.

const fs = require('fs');
const path = require('path');
const session = require('express-session');
const { DATA_DIR } = require('./db');

const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const PRUNE_INTERVAL_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 5000;

function expiresAt(sess) {
  const expires = sess && sess.cookie && sess.cookie.expires;
  return expires ? new Date(expires).getTime() : Infinity;
}

class FileSessionStore extends session.Store {
  constructor() {
    super();
    this.sessions = new Map();
    try {
      const saved = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      Object.entries(saved).forEach(([sid, sess]) => this.sessions.set(sid, sess));
    } catch (err) {
      // No file yet, or unreadable - start empty (everyone just logs in again).
    }
    this.prune();
    setInterval(() => this.prune(), PRUNE_INTERVAL_MS).unref();
  }

  persist() {
    try {
      const tmp = `${SESSIONS_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.sessions)), { mode: 0o600 });
      fs.renameSync(tmp, SESSIONS_FILE);
    } catch (err) {
      console.error('Failed to save sessions.json:', err.message);
    }
  }

  prune() {
    const now = Date.now();
    let changed = false;
    this.sessions.forEach((sess, sid) => {
      if (expiresAt(sess) <= now) {
        this.sessions.delete(sid);
        changed = true;
      }
    });
    if (this.sessions.size > MAX_SESSIONS) {
      const soonestFirst = [...this.sessions.entries()].sort((a, b) => expiresAt(a[1]) - expiresAt(b[1]));
      soonestFirst.slice(0, this.sessions.size - MAX_SESSIONS).forEach(([sid]) => this.sessions.delete(sid));
      changed = true;
    }
    if (changed) this.persist();
  }

  get(sid, cb) {
    const sess = this.sessions.get(sid);
    if (!sess) return cb(null, null);
    if (expiresAt(sess) <= Date.now()) {
      this.sessions.delete(sid);
      return cb(null, null);
    }
    return cb(null, JSON.parse(JSON.stringify(sess)));
  }

  set(sid, sess, cb) {
    this.sessions.set(sid, JSON.parse(JSON.stringify(sess)));
    if (this.sessions.size > MAX_SESSIONS) this.prune();
    this.persist();
    if (cb) cb(null);
  }

  destroy(sid, cb) {
    if (this.sessions.delete(sid)) this.persist();
    if (cb) cb(null);
  }

  // Refreshes expiry in memory only; the next set/prune writes it out.
  touch(sid, sess, cb) {
    const existing = this.sessions.get(sid);
    if (existing && sess && sess.cookie) existing.cookie = JSON.parse(JSON.stringify(sess.cookie));
    if (cb) cb(null);
  }
}

module.exports = { FileSessionStore };
