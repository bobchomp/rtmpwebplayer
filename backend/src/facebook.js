const crypto = require('crypto');
const { readDb, writeDb } = require('./db');

const MAX_OUTPUTS = 10; // keep in sync with channels.js

// Meta deprecates Graph API versions roughly two years after release - if
// calls here start failing with an "unsupported version" error, bump this.
const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const OAUTH_SCOPE = 'pages_show_list,pages_read_engagement,pages_manage_posts';

function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.FACEBOOK_APP_ID,
    redirect_uri: process.env.FACEBOOK_REDIRECT_URI,
    response_type: 'code',
    scope: OAUTH_SCOPE,
    state,
  });
  return `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const params = new URLSearchParams({
    client_id: process.env.FACEBOOK_APP_ID,
    client_secret: process.env.FACEBOOK_APP_SECRET,
    redirect_uri: process.env.FACEBOOK_REDIRECT_URI,
    code,
  });
  const res = await fetch(`${GRAPH_API}/oauth/access_token?${params.toString()}`);
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  return res.json(); // { access_token, token_type, expires_in }
}

// Facebook's short-lived user token (from the code exchange above) is only
// good for ~1-2 hours - exchanging it for a long-lived one (~60 days) is
// what makes the Page token derived from it (below) effectively permanent.
async function exchangeForLongLivedToken(shortLivedToken) {
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: process.env.FACEBOOK_APP_ID,
    client_secret: process.env.FACEBOOK_APP_SECRET,
    fb_exchange_token: shortLivedToken,
  });
  const res = await fetch(`${GRAPH_API}/oauth/access_token?${params.toString()}`);
  if (!res.ok) throw new Error(`Long-lived token exchange failed: ${await res.text()}`);
  return res.json(); // { access_token, token_type, expires_in }
}

// A Page access token derived from a long-lived user token doesn't expire
// on its own (per Meta's docs) - unlike YouTube's refresh token, there's no
// ongoing refresh step needed, so this only ever runs once, right after
// connecting. If the account manages more than one Page, this just picks
// the first one returned (same simplification YouTube's integration makes
// for Google accounts with multiple channels).
async function getFirstPage(userAccessToken) {
  const res = await fetch(
    `${GRAPH_API}/me/accounts?access_token=${encodeURIComponent(userAccessToken)}`
  );
  if (!res.ok) throw new Error(`Failed to list Facebook Pages: ${await res.text()}`);
  const data = await res.json();
  const page = data.data && data.data[0];
  if (!page) {
    throw new Error(
      'No Facebook Page found for this account - you need to manage at least one Page to relay to Facebook.'
    );
  }
  return page; // { id, name, access_token, ... }
}

// Each channel can connect its own Facebook Page independently, so this
// becomes its own entry in channel.outputs (type: 'facebook') - the same
// array custom RTMP and YouTube outputs live in, managed by the same
// generic enable/delete routes in channels.js.
async function handleOAuthCallback(code, channelId) {
  const shortLived = await exchangeCodeForToken(code);
  const longLived = await exchangeForLongLivedToken(shortLived.access_token);
  const page = await getFirstPage(longLived.access_token);

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
    type: 'facebook',
    pageName: page.name,
    pageId: page.id,
    pageAccessToken: page.access_token,
    connectedAt: new Date().toISOString(),
    enabled: true,
    liveVideoId: null,
    streamUrl: null,
  });
  writeDb(db);
  return { id, pageName: page.name };
}

// Creates a new Live Video on the Page and returns its RTMPS ingest URL
// (which already has the stream key baked in - Facebook doesn't split the
// two like YouTube does). Facebook detects on its own when the incoming
// stream stops and ends the live video automatically after a timeout, so -
// same as the YouTube integration - there's no explicit "end" call needed
// from here either.
async function createLiveVideo(pageId, pageAccessToken, title, description) {
  const params = new URLSearchParams({
    access_token: pageAccessToken,
    title: (title || '').trim() || 'Live Stream',
    description: (description || '').trim(),
    status: 'LIVE_NOW',
  });
  const res = await fetch(`${GRAPH_API}/${pageId}/live_videos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!res.ok) throw new Error(`Facebook API error (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return {
    liveVideoId: data.id,
    streamUrl: data.secure_stream_url || data.stream_url,
  };
}

module.exports = { getAuthUrl, handleOAuthCallback, createLiveVideo };
