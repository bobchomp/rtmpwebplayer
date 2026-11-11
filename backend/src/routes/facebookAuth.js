const express = require('express');
const crypto = require('crypto');

const { requireAuth } = require('../authMiddleware');
const { readDb } = require('../db');
const facebook = require('../facebook');
const { currentAccount, ownsChannel } = require('../accounts');
const { MAX_OUTPUTS } = require('./channels');

const router = express.Router();

// After Facebook's sign-in, the Pages to choose from (with their tokens) wait
// here - in memory, keyed by a random id kept in the session - until one is
// picked, rather than being written to the session file. Ten minutes to pick.
const pending = new Map();
const PENDING_MS = 10 * 60 * 1000;

function takePending(req) {
  const entry = pending.get(req.session.facebookPendingId);
  if (!entry || entry.account !== currentAccount(req) || Date.now() > entry.expires) return null;
  return entry;
}

// "+ Add output -> Facebook" on a channel page lands here.
router.get('/connect', requireAuth, (req, res) => {
  if (!facebook.isConfigured()) {
    return res.status(500).send('FACEBOOK_APP_ID / FACEBOOK_APP_SECRET / FACEBOOK_REDIRECT_URI are not configured on the server.');
  }
  const channelId = String(req.query.channelId || '');
  if (!ownsChannel(readDb().channels[channelId], currentAccount(req))) return res.status(404).send('Channel not found.');

  const state = crypto.randomBytes(16).toString('hex');
  req.session.facebookOAuthState = state;
  req.session.facebookOAuthChannelId = channelId;
  res.redirect(facebook.getAuthUrl(state));
});

router.get('/callback', requireAuth, async (req, res) => {
  const { code, state, error } = req.query;
  const channelId = req.session.facebookOAuthChannelId;
  const expectedState = req.session.facebookOAuthState;
  delete req.session.facebookOAuthState;
  delete req.session.facebookOAuthChannelId;

  const back = channelId ? `/dashboard#/channel/${encodeURIComponent(channelId)}` : '/dashboard';
  if (error) return res.redirect(back); // cancelled on Facebook's screen
  if (!state || state !== expectedState || !channelId) {
    return res.status(400).send('Invalid or expired request - please try connecting again from the channel page.');
  }
  if (!ownsChannel(readDb().channels[channelId], currentAccount(req))) return res.status(404).send('Channel not found.');
  if (!code) return res.status(400).send('Missing authorization code.');

  try {
    const pages = await facebook.pagesForCode(code);
    if (!pages.length) {
      return res.status(400).send('No Facebook Pages you can go live on were found. Facebook only allows apps to stream to Pages (not personal profiles), and you need full control of the Page. Check that, then try again - and on Facebook\'s screen, make sure the Page is ticked.');
    }
    if (pages.length === 1) {
      facebook.addOutput(channelId, pages[0], MAX_OUTPUTS);
      return res.redirect(back);
    }
    const id = crypto.randomBytes(16).toString('hex');
    pending.set(id, { account: currentAccount(req), channelId, pages, expires: Date.now() + PENDING_MS });
    setTimeout(() => pending.delete(id), PENDING_MS).unref();
    req.session.facebookPendingId = id;
    res.redirect(`${back}/facebook-page`);
  } catch (err) {
    res.status(500).send(`Failed to connect Facebook: ${err.message}`);
  }
});

// The channel page asks for these when it opens with /facebook-page on the end.
router.get('/pending', requireAuth, (req, res) => {
  const entry = takePending(req);
  if (!entry) return res.json({ pages: [] });
  res.json({ channelId: entry.channelId, pages: entry.pages.map((p) => ({ id: p.id, name: p.name })) });
});

router.post('/pick', requireAuth, express.json(), (req, res) => {
  const entry = takePending(req);
  if (!entry) return res.status(400).json({ error: 'That sign-in has expired - please add Facebook again.' });
  const page = entry.pages.find((p) => p.id === String((req.body && req.body.pageId) || ''));
  if (!page) return res.status(400).json({ error: 'Unknown Page' });
  if (!ownsChannel(readDb().channels[entry.channelId], currentAccount(req))) return res.status(404).json({ error: 'Channel not found' });
  try {
    facebook.addOutput(entry.channelId, page, MAX_OUTPUTS);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  pending.delete(req.session.facebookPendingId);
  delete req.session.facebookPendingId;
  res.json({ ok: true, channelId: entry.channelId });
});

module.exports = router;
