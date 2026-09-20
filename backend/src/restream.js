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
// Only what this app needs: read the account's destination channels, read
// stream/viewer analytics, and (channels.write) push the sermon title back
// out to linked destination channels - see updateChannelMeta() below. If a
// pre-existing connection was made before channels.write was added here,
// its stored token was minted under the narrower scope and needs a
// disconnect/reconnect to pick up write access.
const OAUTH_SCOPE = 'channels.read stream.read channels.write';

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

async function apiPatch(accessToken, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Restream API request to ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Channels are identified by a numeric platformId, not a platform name -
// this is the shared way of telling YouTube/Facebook destinations apart,
// used both for import analytics (restreamImport.js) and for the
// channel-linking picker (routes/restreamAuth.js).
function platformFromUrl(url) {
  if (!url) return null;
  const lower = String(url).toLowerCase();
  if (lower.includes('youtube.com')) return 'youtube';
  if (lower.includes('facebook.com')) return 'facebook';
  return null;
}

// The list itself isn't wrapped in a bare array - like /user/channels, it's
// nested under some key. The exact key isn't documented anywhere reachable,
// so this checks the plausible ones rather than hardcoding a guess; if none
// match, the error names the actual top-level keys so a fix is a one-line
// change instead of another round of guessing.
function extractEventList(res) {
  if (Array.isArray(res)) return res;
  if (res && typeof res === 'object') {
    const candidates = ['events', 'items', 'data', 'results', 'history'];
    for (const key of candidates) {
      if (Array.isArray(res[key])) return res[key];
    }
    throw new Error(
      `Restream /user/events/history response didn't contain a recognizable events array - `
      + `top-level keys were: ${Object.keys(res).join(', ') || '(none)'}`
    );
  }
  throw new Error('Restream /user/events/history returned an unexpected response shape');
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
  const res = await apiGet(accessToken, `/user/events/history${query ? `?${query}` : ''}`);
  return extractEventList(res);
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

// Sets a destination channel's stored default title/description - what
// Restream sends to YouTube/Facebook the next time a stream starts on that
// channel. Requires channels.write.
async function updateChannelMeta(accessToken, channelId, { title, description }) {
  return apiPatch(accessToken, `/user/channel-meta/${encodeURIComponent(channelId)}`, { title, description });
}

module.exports = {
  getAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  listEventHistory,
  listChannels,
  getEventAnalytics,
  updateChannelMeta,
  platformFromUrl,
};
