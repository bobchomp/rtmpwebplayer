const express = require('express');
const crypto = require('crypto');

const auth0 = require('../auth0');

const router = express.Router();

function isConfigured() {
  return !!(
    process.env.AUTH0_DOMAIN &&
    process.env.AUTH0_CLIENT_ID &&
    process.env.AUTH0_CLIENT_SECRET &&
    process.env.AUTH0_CALLBACK_URL &&
    process.env.ADMIN_EMAIL
  );
}

router.get('/login', (req, res) => {
  if (!isConfigured()) {
    return res.status(500).send(
      'Auth0 login is not fully configured (AUTH0_DOMAIN / AUTH0_CLIENT_ID / ' +
      'AUTH0_CLIENT_SECRET / AUTH0_CALLBACK_URL / ADMIN_EMAIL) - see README.'
    );
  }

  const state = crypto.randomBytes(16).toString('hex');
  // Stashed in the session (rather than trusted from the query string on the
  // way back) so the callback can tell a real Auth0 redirect apart from
  // someone just hitting /auth/callback directly with a guessed state.
  req.session.auth0State = state;
  res.redirect(auth0.getAuthUrl(state));
});

router.get('/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;
  const expectedState = req.session.auth0State;
  delete req.session.auth0State;

  if (error) {
    return res.redirect('/login?error=' + encodeURIComponent(errorDescription || error));
  }
  if (!state || state !== expectedState) {
    return res.redirect('/login?error=' + encodeURIComponent('Login request expired or was tampered with - please try again.'));
  }
  if (!code) {
    return res.redirect('/login?error=' + encodeURIComponent('Missing authorization code.'));
  }

  try {
    const tokens = await auth0.exchangeCodeForTokens(code);
    const userInfo = await auth0.getUserInfo(tokens.access_token);

    const allowedEmail = process.env.ADMIN_EMAIL.trim().toLowerCase();
    const gotEmail = (userInfo.email || '').trim().toLowerCase();

    // email_verified matters here specifically because Auth0's own
    // email/password connection lets someone sign up claiming any email
    // address before proving they control it - without this check, an
    // attacker could self-register with ADMIN_EMAIL and log straight in.
    if (!userInfo.email_verified || gotEmail !== allowedEmail) {
      return res.redirect('/login?error=' + encodeURIComponent('That account is not authorized for this dashboard.'));
    }

    req.session.regenerate((err) => {
      if (err) return res.redirect('/login?error=' + encodeURIComponent('Login failed - please try again.'));
      req.session.isAdmin = true;
      res.redirect('/dashboard');
    });
  } catch (err) {
    res.redirect('/login?error=' + encodeURIComponent('Login failed - please try again.'));
  }
});

router.get('/logout', (req, res) => {
  const returnTo = `${req.protocol}://${req.get('host')}/login`;
  req.session.destroy(() => {
    if (!isConfigured()) return res.redirect('/login');
    res.redirect(auth0.getLogoutUrl(returnTo));
  });
});

module.exports = router;
