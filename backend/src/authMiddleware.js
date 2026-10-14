// Sessions from before accounts existed have isAdmin but no account, so they
// are sent back through login once rather than guessing which account they are.
function requireAuth(req, res, next) {
  if (req.session && req.session.isAdmin && req.session.account) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

module.exports = { requireAuth };
