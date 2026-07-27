const crypto = require('crypto');
const { readDb, writeDb } = require('./db');

const MAX_OUTPUTS = 10; // keep in sync with channels.js

const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';
const OAUTH_SCOPE = 'https://www.googleapis.com/auth/youtube';

function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: OAUTH_SCOPE,
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  return res.json();
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
  return res.json();
}

async function apiCall(accessToken, method, path, body) {
  const res = await fetch(`${YOUTUBE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`YouTube API error (${res.status}): ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// Each channel can connect multiple YouTube accounts independently (e.g.
// relaying to two different YouTube channels at once), so each connection
// becomes its own entry in channel.outputs (type: 'youtube') rather than a
// single slot - the same array custom RTMP outputs live in, and the same
// generic add/enable/delete routes in channels.js manage both.
async function handleOAuthCallback(code, channelId) {
  const tokens = await exchangeCodeForTokens(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Disconnect (if already connected) and try connecting again.'
    );
  }

  const channels = await apiCall(tokens.access_token, 'GET', '/channels?part=snippet&mine=true');
  const channelTitle =
    channels.items && channels.items[0] ? channels.items[0].snippet.title : 'Connected';

  const db = readDb();
  const channel = db.channels[channelId];
  if (!channel) throw new Error('Channel not found');
  channel.outputs = channel.outputs || [];
  if (channel.outputs.length >= MAX_OUTPUTS) {
    throw new Error(`Maximum of ${MAX_OUTPUTS} outputs per channel`);
  }

  const id = crypto.randomUUID();
  channel.outputs.push({
    id,
    type: 'youtube',
    channelTitle,
    refreshToken: tokens.refresh_token,
    connectedAt: new Date().toISOString(),
    enabled: true,
    broadcastId: null,
    ingestAddress: null,
    streamName: null,
  });
  writeDb(db);
  return { id, channelTitle };
}

// Creates a broadcast + stream, binds them, and returns the RTMP ingest
// details to relay to. enableAutoStart/enableAutoStop let YouTube manage
// the live/complete transitions itself based on whether it's receiving
// data, so we never need to poll stream health or call transition APIs.
async function createBroadcastAndStream(refreshToken, title, description) {
  const { access_token: accessToken } = await refreshAccessToken(refreshToken);
  const streamTitle = (title || '').trim() || 'Live Stream';
  const streamDescription = (description || '').trim();

  const broadcast = await apiCall(
    accessToken,
    'POST',
    '/liveBroadcasts?part=snippet,status,contentDetails',
    {
      snippet: {
        title: streamTitle,
        description: streamDescription,
        scheduledStartTime: new Date().toISOString(),
      },
      status: { privacyStatus: 'public' },
      contentDetails: { enableAutoStart: true, enableAutoStop: true },
    }
  );

  const stream = await apiCall(accessToken, 'POST', '/liveStreams?part=snippet,cdn,contentDetails', {
    snippet: { title: streamTitle },
    cdn: { frameRate: 'variable', resolution: 'variable', ingestionType: 'rtmp' },
    contentDetails: { isReusable: false },
  });

  await apiCall(
    accessToken,
    'POST',
    `/liveBroadcasts/bind?id=${broadcast.id}&part=id,contentDetails&streamId=${stream.id}`
  );

  return {
    broadcastId: broadcast.id,
    streamId: stream.id,
    ingestionAddress: stream.cdn.ingestionInfo.ingestionAddress,
    streamName: stream.cdn.ingestionInfo.streamName,
  };
}

module.exports = {
  getAuthUrl,
  handleOAuthCallback,
  createBroadcastAndStream,
};
