const express = require('express');
const crypto = require('crypto');

const { requireAuth } = require('../authMiddleware');
const { readDb, writeDb } = require('../db');
const restream = require('../restream');
const { getAccessToken } = require('../restreamSession');

const router = express.Router();

// Account-wide, not per-channel - unlike the YouTube relay (which connects
// a specific Google account to a specific local channel), there's only one
// Restream account in the picture here, and it isn't tied to any single
// local channel (see restreamMatch.js for how an imported event gets
// attributed to one anyway).
router.get('/connect', requireAuth, (req, res) => {
  if (!process.env.RESTREAM_CLIENT_ID || !process.env.RESTREAM_CLIENT_SECRET || !process.env.RESTREAM_REDIRECT_URI) {
    return res.status(500).send('RESTREAM_CLIENT_ID / RESTREAM_CLIENT_SECRET / RESTREAM_REDIRECT_URI are not configured on the server.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.restreamOAuthState = state;
  res.redirect(restream.getAuthUrl(state));
});

router.get('/callback', requireAuth, async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.status(400).send(`Restream returned an error: ${error}`);
  if (!state || state !== req.session.restreamOAuthState) {
    return res.status(400).send('Invalid or expired request - please try connecting again from the Stats page.');
  }
  delete req.session.restreamOAuthState;
  if (!code) return res.status(400).send('Missing authorization code.');

  try {
    const tokens = await restream.exchangeCodeForTokens(code);
    const db = readDb();
    db.restream = {
      refreshToken: tokens.refresh_token,
      connectedAt: new Date().toISOString(),
    };
    writeDb(db);
    res.redirect('/dashboard#/stats');
  } catch (err) {
    res.status(500).send(`Failed to connect Restream: ${err.message}`);
  }
});

router.post('/disconnect', requireAuth, (req, res) => {
  const db = readDb();
  delete db.restream;
  writeDb(db);
  res.json({ ok: true });
});

router.get('/status', requireAuth, (req, res) => {
  const db = readDb();
  res.json({ connected: !!(db.restream && db.restream.refreshToken), connectedAt: db.restream ? db.restream.connectedAt : null });
});

// Backs the "Link Restream channel" picker on a channel's detail page -
// lists the account's destination channels so the admin can pick which
// one(s) this local channel's title/description should sync to.
router.get('/channels', requireAuth, async (req, res) => {
  try {
    const accessToken = await getAccessToken();
    const result = await restream.listChannels(accessToken);
    const channels = (result.channels || []).map((c) => ({
      id: c.id,
      displayName: c.displayName || '',
      channelUrl: c.channelUrl || '',
      platform: restream.platformFromUrl(c.channelUrl),
    }));
    res.json({ channels });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
