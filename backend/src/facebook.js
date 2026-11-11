// Direct Facebook Page output, via Meta's Graph API (Live Video API) - same
// hand-rolled fetch approach as youtube.js, and the same output shape, so
// rtmpHooks.js and the relay treat both alike (see PLATFORMS there).
//
// Facebook only allows apps to go live on Pages, not personal profiles. Each
// go-live creates a new live video on the Page (status LIVE_NOW) with the
// channel's title/description; Facebook hands back a one-off RTMPS address
// the relay sends to. The Meta app stays in Development mode, which works
// for anyone with a role on it without Meta's App Review.
//
// The Page access token (non-expiring, since it's issued from a long-lived
// user token) lives in db.facebookTokens[outputId], never on the output.

const crypto = require('crypto');
const { readDb, writeDb } = require('./db');
const { updateOutput, setStatus, RECONNECT_GRACE_MS } = require('./platformOutputs');

const GRAPH_VERSION = process.env.FACEBOOK_GRAPH_VERSION || 'v23.0';
// Overridable only so the client can be pointed at a local mock for testing.
const GRAPH_BASE = `${process.env.FACEBOOK_GRAPH_BASE || 'https://graph.facebook.com'}/${GRAPH_VERSION}`;
const DIALOG_URL = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;
// Streaming to a Page needs a Page token with pages_read_engagement and
// pages_manage_posts; pages_show_list lists the Pages to pick from.
const SCOPE = 'pages_show_list,pages_read_engagement,pages_manage_posts';

function isConfigured() {
  return !!(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET && process.env.FACEBOOK_REDIRECT_URI);
}

// Apps using "Facebook Login for Business" may have a login Configuration
// (FACEBOOK_CONFIG_ID), which replaces the scope list.
function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.FACEBOOK_APP_ID,
    redirect_uri: process.env.FACEBOOK_REDIRECT_URI,
    response_type: 'code',
    state,
  });
  if (process.env.FACEBOOK_CONFIG_ID) params.set('config_id', process.env.FACEBOOK_CONFIG_ID);
  else params.set('scope', SCOPE);
  return `${DIALOG_URL}?${params.toString()}`;
}

async function graph(method, path, params = {}, accessToken) {
  const query = new URLSearchParams(params);
  if (accessToken) query.set('access_token', accessToken);
  const url = `${GRAPH_BASE}${path}`;
  const res = method === 'GET'
    ? await fetch(`${url}?${query.toString()}`)
    : await fetch(url, { method, body: query });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const e = body.error || {};
    // Facebook's messages can be as vague as "Permissions error", so the
    // codes go along too - they're what its docs and support go by.
    const codes = [e.code && `code ${e.code}`, e.error_subcode && `subcode ${e.error_subcode}`].filter(Boolean).join(', ');
    const err = new Error(`Facebook API error (${res.status}): ${e.message || res.statusText}${codes ? ` (${codes})` : ''}`);
    // 190 = the token was revoked or has expired.
    if (e.code === 190) err.reconnect = true;
    throw err;
  }
  return body;
}

// OAuth callback: swaps the code for a long-lived user token and returns the
// Pages this person can go live on, each with its own Page token.
async function pagesForCode(code) {
  const short = await graph('GET', '/oauth/access_token', {
    client_id: process.env.FACEBOOK_APP_ID,
    client_secret: process.env.FACEBOOK_APP_SECRET,
    redirect_uri: process.env.FACEBOOK_REDIRECT_URI,
    code,
  });
  const long = await graph('GET', '/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: process.env.FACEBOOK_APP_ID,
    client_secret: process.env.FACEBOOK_APP_SECRET,
    fb_exchange_token: short.access_token,
  });
  // Facebook lets people untick permissions on its sign-in screen; going
  // live needs all of these, so say which is missing rather than failing
  // later with a vague "Permissions error".
  const perms = await graph('GET', '/me/permissions', {}, long.access_token);
  const granted = (perms.data || []).filter((p) => p.status === 'granted').map((p) => p.permission);
  const missing = SCOPE.split(',').filter((p) => !granted.includes(p));
  if (missing.length) {
    throw new Error(`Facebook didn't grant ${missing.join(', ')}. Add Facebook again and leave every permission switched on`
      + `${process.env.FACEBOOK_CONFIG_ID ? ' - and check they are all ticked in the Meta app\'s Facebook Login for Business configuration' : ''}.`);
  }
  const res = await graph('GET', '/me/accounts', { fields: 'id,name,access_token,tasks', limit: '100' }, long.access_token);
  return (res.data || [])
    // CREATE_CONTENT is the Page task going live needs.
    .filter((p) => p.access_token && (!p.tasks || p.tasks.includes('CREATE_CONTENT')))
    .map((p) => ({ id: p.id, name: p.name, token: p.access_token }));
}

function addOutput(channelId, page, maxOutputs) {
  const db = readDb();
  const channel = db.channels[channelId];
  if (!channel) throw new Error('Channel not found');
  channel.outputs = channel.outputs || [];
  if (channel.outputs.length >= maxOutputs) throw new Error(`Maximum of ${maxOutputs} outputs per channel`);
  const output = {
    id: crypto.randomUUID(),
    type: 'facebook',
    facebookPageId: page.id,
    facebookPageName: page.name,
    enabled: true,
    connectedAt: new Date().toISOString(),
    // Per go-live (see startBroadcast): the live video's id and its one-off
    // RTMPS address. Named like youtube.js's so the relay code is shared.
    session: null,
    broadcastId: null,
    ingestUrl: null,
    lastStatus: null,
  };
  channel.outputs.push(output);
  db.facebookTokens = db.facebookTokens || {};
  db.facebookTokens[output.id] = page.token;
  writeDb(db);
  return output;
}

function tokenFor(outputId) {
  const token = (readDb().facebookTokens || {})[outputId];
  if (!token) {
    const err = new Error('Facebook is not connected for this output.');
    err.reconnect = true;
    throw err;
  }
  return token;
}

function videoFields(channel) {
  return {
    title: String(channel.title || channel.name || 'Live stream').slice(0, 255),
    description: String(channel.description || ''),
  };
}

async function watchUrl(token, liveVideoId) {
  try {
    const info = await graph('GET', `/${liveVideoId}`, { fields: 'permalink_url' }, token);
    if (info.permalink_url) return new URL(info.permalink_url, 'https://www.facebook.com').toString();
  } catch (err) { /* fall through to the Page's videos */ }
  return null;
}

const ENDED = ['VOD', 'LIVE_STOPPED', 'PROCESSING'];

async function startBroadcast(channelId, outputId, session) {
  try {
    const token = tokenFor(outputId);
    const channel = readDb().channels[channelId];
    let output = channel && channel.outputs.find((o) => o.id === outputId);
    if (!output || output.session !== session) return;

    // A quick reconnect carries on in the same live video if Facebook still
    // has it live; its RTMPS address keeps working until it's ended.
    let liveVideoId = null;
    let ingestUrl = null;
    const recent = output.previousBroadcastId && output.previousEndedAt
      && Date.now() - new Date(output.previousEndedAt).getTime() < RECONNECT_GRACE_MS;
    if (recent && output.ingestUrl) {
      const prev = await graph('GET', `/${output.previousBroadcastId}`, { fields: 'status' }, token).catch(() => null);
      if (prev && !ENDED.includes(prev.status)) {
        liveVideoId = output.previousBroadcastId;
        ingestUrl = output.ingestUrl;
      }
    }
    if (!liveVideoId && output.previousBroadcastId) {
      await endLiveVideo(token, output.previousBroadcastId).catch(() => {});
    }
    if (!liveVideoId) {
      const created = await graph('POST', `/${output.facebookPageId}/live_videos`,
        { status: 'LIVE_NOW', ...videoFields(channel) }, token);
      liveVideoId = created.id;
      ingestUrl = created.secure_stream_url || created.stream_url;
      if (!ingestUrl) throw new Error('Facebook did not return a stream address for the live video.');
    }

    output = readDb().channels[channelId].outputs.find((o) => o.id === outputId);
    if (!output || output.session !== session) { // stream ended meanwhile
      if (liveVideoId !== (output && output.previousBroadcastId)) await endLiveVideo(token, liveVideoId).catch(() => {});
      return;
    }
    // Setting broadcastId (with ingestUrl) is what releases the relay.
    updateOutput(channelId, outputId, (o) => {
      o.broadcastId = liveVideoId;
      o.ingestUrl = ingestUrl;
      o.previousBroadcastId = null;
      o.previousEndedAt = null;
    });
    setStatus(channelId, outputId, true, 'Live on Facebook', { url: await watchUrl(token, liveVideoId) });
  } catch (err) {
    console.error(`[facebook] Channel ${channelId} output ${outputId}: ${err.message}`);
    setStatus(channelId, outputId, false,
      err.reconnect ? 'Facebook needs reconnecting - delete this output and add Facebook again.' : err.message);
  }
}

// Ends a live video, or deletes one Facebook never received video for.
async function endLiveVideo(token, liveVideoId) {
  try {
    const info = await graph('GET', `/${liveVideoId}`, { fields: 'status' }, token);
    if (ENDED.includes(info.status)) return null;
    if (info.status === 'UNPUBLISHED' || info.status === 'SCHEDULED_UNPUBLISHED') {
      await graph('DELETE', `/${liveVideoId}`, {}, token);
      return 'deleted';
    }
    await graph('POST', `/${liveVideoId}`, { end_live_video: 'true' }, token);
    return 'ended';
  } catch (err) {
    console.error(`[facebook] Ending live video ${liveVideoId}: ${err.message}`);
    throw err;
  }
}

// Called RECONNECT_GRACE_MS after the stream stops, unless it came back.
async function finishBroadcast(channelId, outputId, liveVideoId) {
  const channel = readDb().channels[channelId];
  const output = channel && (channel.outputs || []).find((o) => o.id === outputId);
  if (!output || output.session || output.previousBroadcastId !== liveVideoId) return;
  try {
    await endLiveVideo(tokenFor(outputId), liveVideoId);
    setStatus(channelId, outputId, true, 'Stream ended - Facebook live video ended');
  } catch (err) {
    setStatus(channelId, outputId, false,
      `Stream ended, but the Facebook live video couldn't be ended (Facebook will end it itself shortly): ${err.message}`);
  }
  updateOutput(channelId, outputId, (o) => {
    if (o.previousBroadcastId !== liveVideoId) return;
    o.previousBroadcastId = null;
    o.previousEndedAt = null;
    o.ingestUrl = null;
  });
}

// Title/description edited mid-stream.
async function updateBroadcastDetails(channelId) {
  const channel = readDb().channels[channelId];
  if (!channel) return;
  for (const output of (channel.outputs || []).filter((o) => o.type === 'facebook' && o.broadcastId)) {
    const url = output.lastStatus && output.lastStatus.url;
    try {
      // eslint-disable-next-line no-await-in-loop
      await graph('POST', `/${output.broadcastId}`, videoFields(channel), tokenFor(output.id));
      setStatus(channelId, output.id, true, 'Live on Facebook - title updated', { url });
    } catch (err) {
      console.error(`[facebook] Title update for ${channelId}/${output.id}: ${err.message}`);
      setStatus(channelId, output.id, false, `Couldn't update the Facebook title: ${err.message}`, { url });
    }
  }
}

module.exports = {
  isConfigured,
  getAuthUrl,
  pagesForCode,
  addOutput,
  startBroadcast,
  finishBroadcast,
  updateBroadcastDetails,
  RECONNECT_GRACE_MS,
};
