// Turns an account's stored Restream refresh token into a fresh access
// token - used by the import flow (restreamImport.js) via routes/stats.js.
// Each account connects its own Restream (db.restreamAccounts[email], see
// routes/restreamAuth.js). See docs/restream-api-notes.md for the API itself.

const { readDb } = require('./db');
const restream = require('./restream');

async function getAccessToken(account) {
  const db = readDb();
  const connection = db.restreamAccounts && db.restreamAccounts[account];
  if (!connection || !connection.refreshToken) {
    throw new Error('Restream is not connected - connect it first from the Stats page.');
  }
  const tokens = await restream.refreshAccessToken(connection.refreshToken);
  return tokens.access_token;
}

module.exports = { getAccessToken };
