// Thin wrapper around Restream's API - same hand-rolled fetch-based
// approach as youtube.js/auth0.js, rather than a client library.
//
// The OAuth2 endpoints below (authorize/token) are confirmed against
// Restream's published docs. The Events/Analytics endpoint paths and exact
// response shapes are NOT independently verified against the live API from
// this environment (developers.restream.io wasn't reachable to confirm
// directly) - they're built from the best available public documentation
// and are the first thing to check against the real docs once the Restream
// app is registered, before relying on this for real imports. See
// restreamImport.js for where these get used.

// RESTREAM_API_BASE is an internal override, not something a real
// deployment needs to set (real Restream tenants all share the one fixed
// domain, unlike Auth0's per-tenant custom domain) - it exists purely so
// this whole client can be pointed at a local mock server for testing.
const BASE = process.env.RESTREAM_API_BASE || 'https://api.restream.io';
const AUTH_BASE = BASE;
const API_BASE = `${BASE}/v2`;
const OAUTH_SCOPE = 'profile.default channel.default'; // TODO verify against the real docs - see note above

function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.RESTREAM_CLIENT_ID,
    redirect_uri: process.env.RESTREAM_REDIRECT_URI,
    response_type: 'code',
    scope: OAUTH_SCOPE,
    state,
  });
  return `${AUTH_BASE}/oauth/authorize?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const res = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.RESTREAM_CLIENT_ID,
      client_secret: process.env.RESTREAM_CLIENT_SECRET,
      code,
      redirect_uri: process.env.RESTREAM_REDIRECT_URI,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  return res.json();
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.RESTREAM_CLIENT_ID,
      client_secret: process.env.RESTREAM_CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
  return res.json();
}

async function apiGet(accessToken, path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Restream API request to ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Past stream events in a date range - TODO verify the exact path/params
// (built from the "list event history" capability documented for the
// Events API; the Dart client's listEventHistory() suggests a dedicated
// /user/events/history path rather than a status filter on /user/events,
// but that's not independently confirmed here).
async function listEventHistory(accessToken, { from, to } = {}) {
  const params = new URLSearchParams();
  if (from) params.set('from', new Date(from).toISOString());
  if (to) params.set('to', new Date(to).toISOString());
  const query = params.toString();
  return apiGet(accessToken, `/user/events/history${query ? `?${query}` : ''}`);
}

// Per-event viewer analytics, broken down per destination channel - TODO
// verify the exact path/response shape against the real docs. Expected
// shape per the public Analytics API description: total views and other
// metrics per destination channel for this event.
async function getEventAnalytics(accessToken, eventId) {
  return apiGet(accessToken, `/user/events/${encodeURIComponent(eventId)}/analytics`);
}

module.exports = {
  getAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  listEventHistory,
  getEventAnalytics,
};
