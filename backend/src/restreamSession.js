// Turns the stored Restream refresh token into a fresh access token - used
// by the import flow (restreamImport.js) via routes/stats.js, and by the
// OAuth connect/disconnect/status routes (routes/restreamAuth.js). See
// docs/restream-api-notes.md for what's known about the API itself.

const { readDb } = require('./db');
const restream = require('./restream');

async function getAccessToken() {
  const db = readDb();
  if (!db.restream || !db.restream.refreshToken) {
    throw new Error('Restream is not connected - connect it first from the Stats page.');
  }
  const tokens = await restream.refreshAccessToken(db.restream.refreshToken);
  return tokens.access_token;
}

module.exports = { getAccessToken };
