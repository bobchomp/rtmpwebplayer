// Thin wrapper around Restream's API - same hand-rolled fetch-based
// approach as youtube.js/auth0.js, rather than a client library.
//
// OAuth endpoints, scopes, the /user/channels shape, and the
// /user/events/{id}/analytics/viewers shape are all confirmed against
// Restream's real developer-portal docs and the app's own registered
// scope list. The exact response shape of /user/events/history (pagination
// params, whether list items carry the full Event object) is built from
// the documented single-Event object shape (id/status/title/description/
// coverUrl/isRecordOnly/scheduledFor/startedAt/finishedAt/destinations) and
// is the one remaining thing to double check once a real account is
// connected. See restreamImport.js for where these get used.

// RESTREAM_API_BASE is an internal override, not something a real
// deployment needs to set (real Restream tenants all share the one fixed
// domain, unlike Auth0's per-tenant custom domain) - it exists purely so
// this whole client can be pointed at a local mock server for testing.
const BASE = process.env.RESTREAM_API_BASE || 'https://api.restream.io';
const AUTH_BASE = BASE;
const API_BASE = `${BASE}/v2`;
// Only what this app needs: read the account's destination channels, and
// read stream/viewer analytics. There's no dedicated "analytics" scope.
const OAUTH_SCOPE = 'channels.read stream.read';

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

// Past stream events in a date range. Each event has the shape:
// { id, status, title, description, coverUrl, isRecordOnly, scheduledFor,
//   startedAt, finishedAt, destinations: [{ channelId, externalUrl,
//   streamingPlatformId }] } - scheduledFor/startedAt/finishedAt are unix
// epoch seconds.
async function listEventHistory(accessToken, { from, to } = {}) {
  const params = new URLSearchParams();
  if (from) params.set('from', new Date(from).toISOString());
  if (to) params.set('to', new Date(to).toISOString());
  const query = params.toString();
  return apiGet(accessToken, `/user/events/history${query ? `?${query}` : ''}`);
}

// The account's destination channels: { channels: [{ id, platformId,
// channelUrl, displayName }] }. platformId is an opaque Restream-internal
// number - platform (YouTube vs Facebook) has to be inferred from
// channelUrl instead.
async function listChannels(accessToken) {
  return apiGet(accessToken, '/user/channels');
}

// Per-event viewer analytics: { total: {...}, byChannel: { "<channelId>":
// { mean, max, viewsTotal, peakTime, watchedTime, viewersPerMinute } } }.
// Returns a 404 (thrown as an error by apiGet) if the event has no
// analytics - callers should treat that as "no views" rather than a
// hard failure.
async function getEventAnalytics(accessToken, eventId) {
  return apiGet(accessToken, `/user/events/${encodeURIComponent(eventId)}/analytics/viewers`);
}

module.exports = {
  getAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  listEventHistory,
  listChannels,
  getEventAnalytics,
};
