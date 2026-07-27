const express = require('express');
const crypto = require('crypto');

const { requireAuth } = require('../authMiddleware');
const { readDb } = require('../db');
const facebook = require('../facebook');

const router = express.Router();

router.get('/connect', requireAuth, (req, res) => {
  if (!process.env.FACEBOOK_APP_ID || !process.env.FACEBOOK_APP_SECRET) {
    return res.status(500).send('FACEBOOK_APP_ID / FACEBOOK_APP_SECRET are not configured on the server.');
  }
  const channelId = req.query.channelId;
  if (!channelId) return res.status(400).send('channelId is required.');
  const db = readDb();
  if (!db.channels[channelId]) return res.status(404).send('Channel not found.');

  const state = crypto.randomBytes(16).toString('hex');
  // Stashed in the session (rather than passed through Facebook's redirect)
  // so it can't be tampered with client-side - the callback trusts these
  // session values, not anything in the query string it gets back.
  req.session.facebookOAuthState = state;
  req.session.facebookOAuthChannelId = channelId;
  res.redirect(facebook.getAuthUrl(state));
});

router.get('/callback', requireAuth, async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.status(400).send(`Facebook returned an error: ${error}`);
  if (!state || state !== req.session.facebookOAuthState) {
    return res.status(400).send('Invalid or expired request - please try connecting again from the dashboard.');
  }
  const channelId = req.session.facebookOAuthChannelId;
  delete req.session.facebookOAuthState;
  delete req.session.facebookOAuthChannelId;
  if (!channelId) return res.status(400).send('Missing channel - please try connecting again from the dashboard.');
  if (!code) return res.status(400).send('Missing authorization code.');

  try {
    await facebook.handleOAuthCallback(code, channelId);
    res.redirect('/#/channel/' + encodeURIComponent(channelId));
  } catch (err) {
    res.status(500).send(`Failed to connect Facebook: ${err.message}`);
  }
});

// Disconnecting/removing a Facebook output goes through the generic
// DELETE /api/channels/:id/outputs/:outputId route in channels.js instead
// of a dedicated route here - it's just an entry in the same outputs array
// as custom RTMP and YouTube outputs.

module.exports = router;
