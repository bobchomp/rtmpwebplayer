const express = require('express');

const router = express.Router();

// Login/logout themselves live in routes/auth0.js (the Auth0 redirect
// flow) - this just answers "is the current session authenticated", used
// by both the dashboard (to gate the app) and login.js (to skip the login
// screen if a session already exists).
router.get('/me', (req, res) => {
  const authenticated = !!(req.session && req.session.isAdmin && req.session.account);
  res.json({ authenticated, email: authenticated ? req.session.account : null });
});

module.exports = router;
