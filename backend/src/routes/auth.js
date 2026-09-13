const express = require('express');

const router = express.Router();

// Login/logout themselves live in routes/auth0.js (the Auth0 redirect
// flow) - this just answers "is the current session authenticated", used
// by both the dashboard (to gate the app) and login.js (to skip the login
// screen if a session already exists).
router.get('/me', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.isAdmin) });
});

module.exports = router;
