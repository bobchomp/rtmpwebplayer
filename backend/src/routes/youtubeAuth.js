const express = require('express');
const crypto = require('crypto');

const { requireAuth } = require('../authMiddleware');
const { readDb } = require('../db');
const youtube = require('../youtube');
const { currentAccount, ownsChannel } = require('../accounts');
const { MAX_OUTPUTS } = require('./channels');

const router = express.Router();

// "+ Add output -> YouTube" on a channel page lands here, which sends the
// browser to Google's sign-in. The callback adds the YouTube output to that
// channel - see youtube.connect().
router.get('/connect', requireAuth, (req, res) => {
  if (!youtube.isConfigured()) {
    return res.status(500).send('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI are not configured on the server.');
  }
  const channelId = String(req.query.channelId || '');
  if (!ownsChannel(readDb().channels[channelId], currentAccount(req))) return res.status(404).send('Channel not found.');

  const state = crypto.randomBytes(16).toString('hex');
  // Kept in the session rather than passed through Google's redirect, so the
  // callback only trusts what it stored itself.
  req.session.youtubeOAuthState = state;
  req.session.youtubeOAuthChannelId = channelId;
  res.redirect(youtube.getAuthUrl(state));
});

router.get('/callback', requireAuth, async (req, res) => {
  const { code, state, error } = req.query;
  const channelId = req.session.youtubeOAuthChannelId;
  const expectedState = req.session.youtubeOAuthState;
  delete req.session.youtubeOAuthState;
  delete req.session.youtubeOAuthChannelId;

  const back = channelId ? `/dashboard#/channel/${encodeURIComponent(channelId)}` : '/dashboard';
  if (error === 'access_denied') return res.redirect(back); // cancelled on Google's screen
  if (error) return res.status(400).send(`Google returned an error: ${error}`);
  if (!state || state !== expectedState || !channelId) {
    return res.status(400).send('Invalid or expired request - please try connecting again from the channel page.');
  }
  if (!ownsChannel(readDb().channels[channelId], currentAccount(req))) return res.status(404).send('Channel not found.');
  if (!code) return res.status(400).send('Missing authorization code.');

  try {
    await youtube.connect(code, channelId, MAX_OUTPUTS);
    res.redirect(back);
  } catch (err) {
    res.status(500).send(`Failed to connect YouTube: ${err.message}`);
  }
});

module.exports = router;
