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
//
// returnTo lets a caller other than the Stats page (e.g. the "Link
// Restream channel" picker on a channel's detail page) send the admin back
// to where they started once OAuth completes, instead of always landing on
// Stats. Restricted to same-app dashboard hash routes to rule out this
// being turned into an open redirect.
const SAFE_RETURN_TO = /^\/dashboard#\/[a-zA-Z0-9/_-]*$/;

router.get('/connect', requireAuth, (req, res) => {
  if (!process.env.RESTREAM_CLIENT_ID || !process.env.RESTREAM_CLIENT_SECRET || !process.env.RESTREAM_REDIRECT_URI) {
    return res.status(500).send('RESTREAM_CLIENT_ID / RESTREAM_CLIENT_SECRET / RESTREAM_REDIRECT_URI are not configured on the server.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.restreamOAuthState = state;
  const returnTo = req.query.returnTo;
  req.session.restreamOAuthReturnTo = (typeof returnTo === 'string' && SAFE_RETURN_TO.test(returnTo)) ? returnTo : null;
  res.redirect(restream.getAuthUrl(state));
});

router.get('/callback', requireAuth, async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.status(400).send(`Restream returned an error: ${error}`);
  if (!state || state !== req.session.restreamOAuthState) {
    return res.status(400).send('Invalid or expired request - please try connecting again from the Stats page.');
  }
  delete req.session.restreamOAuthState;
  const returnTo = req.session.restreamOAuthReturnTo || '/dashboard#/stats';
  delete req.session.restreamOAuthReturnTo;
  if (!code) return res.status(400).send('Missing authorization code.');

  try {
    const tokens = await restream.exchangeCodeForTokens(code);
    const db = readDb();
    db.restream = {
      refreshToken: tokens.refresh_token,
      connectedAt: new Date().toISOString(),
    };
    writeDb(db);
    res.redirect(returnTo);
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
  const db = readDb();
  if (!db.restream || !db.restream.refreshToken) {
    return res.status(409).json({ error: 'not_connected' });
  }
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
