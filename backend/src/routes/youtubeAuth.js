const express = require('express');
const crypto = require('crypto');

const { requireAuth } = require('../authMiddleware');
const { readDb } = require('../db');
const youtube = require('../youtube');

const router = express.Router();

router.get('/status', requireAuth, (req, res) => {
  const channelId = req.query.channelId;
  if (!channelId) return res.status(400).json({ error: 'channelId is required' });
  res.json(youtube.getStatus(channelId));
});

router.get('/connect', requireAuth, (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).send('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured on the server.');
  }
  const channelId = req.query.channelId;
  if (!channelId) return res.status(400).send('channelId is required.');
  const db = readDb();
  if (!db.channels[channelId]) return res.status(404).send('Channel not found.');

  const state = crypto.randomBytes(16).toString('hex');
  // Stashed in the session (rather than passed through Google's redirect)
  // so it can't be tampered with client-side - the callback trusts these
  // session values, not anything in the query string it gets back.
  req.session.youtubeOAuthState = state;
  req.session.youtubeOAuthChannelId = channelId;
  res.redirect(youtube.getAuthUrl(state));
});

router.get('/callback', requireAuth, async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.status(400).send(`Google returned an error: ${error}`);
  if (!state || state !== req.session.youtubeOAuthState) {
    return res.status(400).send('Invalid or expired request - please try connecting again from the dashboard.');
  }
  const channelId = req.session.youtubeOAuthChannelId;
  delete req.session.youtubeOAuthState;
  delete req.session.youtubeOAuthChannelId;
  if (!channelId) return res.status(400).send('Missing channel - please try connecting again from the dashboard.');
  if (!code) return res.status(400).send('Missing authorization code.');

  try {
    await youtube.handleOAuthCallback(code, channelId);
    res.redirect('/#/channel/' + encodeURIComponent(channelId));
  } catch (err) {
    res.status(500).send(`Failed to connect YouTube: ${err.message}`);
  }
});

router.post('/disconnect', requireAuth, (req, res) => {
  const channelId = req.body && req.body.channelId;
  if (!channelId) return res.status(400).json({ error: 'channelId is required' });
  youtube.disconnect(channelId);
  res.json({ ok: true });
});

module.exports = router;
