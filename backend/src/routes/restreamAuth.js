const express = require('express');
const crypto = require('crypto');

const { requireAuth } = require('../authMiddleware');
const { readDb, writeDb } = require('../db');
const restream = require('../restream');
const { currentAccount } = require('../accounts');
const { canSendTitles } = require('../restreamTitleSync');

const router = express.Router();

// One Restream connection per dashboard account (db.restreamAccounts,
// keyed by the account's email), not per channel - unlike the YouTube relay,
// which connects a Google account to one specific channel. See
// restreamMatch.js for how an imported event gets attributed to one of that
// account's channels.
router.get('/connect', requireAuth, (req, res) => {
  if (!process.env.RESTREAM_CLIENT_ID || !process.env.RESTREAM_CLIENT_SECRET || !process.env.RESTREAM_REDIRECT_URI) {
    return res.status(500).send('RESTREAM_CLIENT_ID / RESTREAM_CLIENT_SECRET / RESTREAM_REDIRECT_URI are not configured on the server.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.restreamOAuthState = state;
  // Where to send the browser afterwards: a dashboard route such as
  // #/channel/<id>, so connecting from a channel page lands back there.
  const returnTo = typeof req.query.return === 'string' && /^#\/[A-Za-z0-9/_-]*$/.test(req.query.return) ? req.query.return : '#/stats';
  req.session.restreamReturnTo = returnTo;
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
    db.restreamAccounts = db.restreamAccounts || {};
    db.restreamAccounts[currentAccount(req)] = {
      refreshToken: tokens.refresh_token,
      connectedAt: new Date().toISOString(),
      // What this connection was granted - older connections predate
      // channels.write and need reconnecting before titles can be sent.
      scope: restream.OAUTH_SCOPE,
    };
    writeDb(db);
    const returnTo = req.session.restreamReturnTo || '#/stats';
    delete req.session.restreamReturnTo;
    res.redirect(`/dashboard${returnTo}`);
  } catch (err) {
    res.status(500).send(`Failed to connect Restream: ${err.message}`);
  }
});

router.post('/disconnect', requireAuth, (req, res) => {
  const db = readDb();
  if (db.restreamAccounts) delete db.restreamAccounts[currentAccount(req)];
  writeDb(db);
  res.json({ ok: true });
});

router.get('/status', requireAuth, (req, res) => {
  const db = readDb();
  const connection = db.restreamAccounts && db.restreamAccounts[currentAccount(req)];
  res.json({
    connected: !!(connection && connection.refreshToken),
    connectedAt: connection ? connection.connectedAt : null,
    canSendTitles: canSendTitles(connection),
  });
});

module.exports = router;
