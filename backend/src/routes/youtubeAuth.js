const express = require('express');
const crypto = require('crypto');

const { requireAuth } = require('../authMiddleware');
const youtube = require('../youtube');

const router = express.Router();

router.get('/status', requireAuth, (req, res) => {
  res.json(youtube.getStatus());
});

router.get('/connect', requireAuth, (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).send('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured on the server.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.youtubeOAuthState = state;
  res.redirect(youtube.getAuthUrl(state));
});

router.get('/callback', requireAuth, async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.status(400).send(`Google returned an error: ${error}`);
  if (!state || state !== req.session.youtubeOAuthState) {
    return res.status(400).send('Invalid or expired request - please try connecting again from the dashboard.');
  }
  delete req.session.youtubeOAuthState;
  if (!code) return res.status(400).send('Missing authorization code.');

  try {
    await youtube.handleOAuthCallback(code);
    res.redirect('/');
  } catch (err) {
    res.status(500).send(`Failed to connect YouTube: ${err.message}`);
  }
});

router.post('/disconnect', requireAuth, (req, res) => {
  youtube.disconnect();
  res.json({ ok: true });
});

module.exports = router;
