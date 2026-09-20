// Turns the stored Restream refresh token into a fresh access token -
// shared by the import flow (restreamImport.js) and the per-channel title
// sync (routes/channels.js, routes/restreamAuth.js), so both go through
// the one "are we even connected" check.

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
