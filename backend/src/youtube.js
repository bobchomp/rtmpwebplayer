// Direct YouTube output, via the YouTube Data API v3 - same hand-rolled
// fetch-based approach as restream.js/auth0.js, rather than a client library.
//
// Each YouTube output (an entry in channel.outputs with type 'youtube') keeps
// one reusable YouTube stream (fixed ingest URL + key), created the first
// time it's needed. Every time the channel goes live, a new broadcast with
// the channel's title/description is created and bound to that stream; the
// relay (rtmp/relay-start.sh) only starts sending video once that's done, and
// YouTube starts and ends the broadcast itself (enableAutoStart/AutoStop).
//
// The Google refresh token lives in db.youtubeTokens[outputId], not on the
// output, so channel JSON sent to the dashboard never carries it.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { readDb, writeDb } = require('./db');

// Overridable only so the whole client can be pointed at a local mock for
// testing, like RESTREAM_API_BASE.
const GOOGLE_API_BASE = process.env.GOOGLE_API_BASE || 'https://www.googleapis.com';
const GOOGLE_TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const YOUTUBE_API = `${GOOGLE_API_BASE}/youtube/v3`;
const YOUTUBE_UPLOAD_API = `${GOOGLE_API_BASE}/upload/youtube/v3`;
const OAUTH_SCOPE = 'https://www.googleapis.com/auth/youtube';

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const PRIVACY_STATUSES = ['public', 'unlisted', 'private'];

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
}

function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    access_type: 'offline',
    // Always show the consent screen, so Google always returns a refresh
    // token (it only does so on consent).
    prompt: 'consent',
    scope: OAUTH_SCOPE,
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function tokenRequest(params) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      ...params,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Google sign-in request failed: ${text}`);
    // invalid_grant means the connection was revoked or expired.
    if (/invalid_grant/.test(text)) err.reconnect = true;
    throw err;
  }
  return res.json();
}

async function accessTokenFor(outputId) {
  const refreshToken = (readDb().youtubeTokens || {})[outputId];
  if (!refreshToken) {
    const err = new Error('YouTube is not connected for this output.');
    err.reconnect = true;
    throw err;
  }
  const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  return tokens.access_token;
}

async function apiCall(accessToken, method, apiPath, body) {
  const res = await fetch(`${YOUTUBE_API}${apiPath}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`YouTube API error (${res.status}): ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// Called from the OAuth callback: stores the connection as a new YouTube
// output on the channel. Returns the output.
async function connect(code, channelId, maxOutputs) {
  const tokens = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
  });
  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh token. Remove this app at myaccount.google.com/permissions and connect again.');
  }

  const channels = await apiCall(tokens.access_token, 'GET', '/channels?part=snippet&mine=true');
  const ytChannel = channels.items && channels.items[0];
  if (!ytChannel) throw new Error('That Google account has no YouTube channel.');

  const db = readDb();
  const channel = db.channels[channelId];
  if (!channel) throw new Error('Channel not found');
  channel.outputs = channel.outputs || [];
  if (channel.outputs.length >= maxOutputs) throw new Error(`Maximum of ${maxOutputs} outputs per channel`);

  const output = {
    id: crypto.randomUUID(),
    type: 'youtube',
    youtubeChannelTitle: ytChannel.snippet.title,
    youtubeChannelId: ytChannel.id,
    privacyStatus: 'public',
    enabled: true,
    connectedAt: new Date().toISOString(),
    // Filled in when needed - see ensureStream()/startBroadcast().
    streamId: null,
    ingestUrl: null,
    session: null,
    broadcastId: null,
    lastStatus: null,
  };
  channel.outputs.push(output);
  db.youtubeTokens = db.youtubeTokens || {};
  db.youtubeTokens[output.id] = tokens.refresh_token;
  writeDb(db);
  return output;
}

function forget(outputId) {
  const db = readDb();
  if (db.youtubeTokens && db.youtubeTokens[outputId]) {
    delete db.youtubeTokens[outputId];
    writeDb(db);
  }
}

// Updates one YouTube output in place (re-reading the db, since these run
// detached from any request and the network calls take a while).
function updateOutput(channelId, outputId, mutate) {
  const db = readDb();
  const channel = db.channels[channelId];
  const output = channel && (channel.outputs || []).find((o) => o.id === outputId);
  if (!output) return null;
  mutate(output, channel);
  writeDb(db);
  return output;
}

function setStatus(channelId, outputId, ok, message, extra = {}) {
  updateOutput(channelId, outputId, (output) => {
    output.lastStatus = { at: new Date().toISOString(), ok, message, ...extra };
  });
}

// The output's reusable YouTube stream - the fixed ingest URL + key the relay
// sends to. Created once; recreated if it was deleted on YouTube's side.
async function ensureStream(accessToken, channelId, output) {
  if (output.streamId) {
    const existing = await apiCall(accessToken, 'GET', `/liveStreams?part=id&id=${encodeURIComponent(output.streamId)}`);
    if (existing.items && existing.items.length) return output;
  }
  const stream = await apiCall(accessToken, 'POST', '/liveStreams?part=snippet,cdn,contentDetails', {
    snippet: { title: 'RTMP Web Player' },
    cdn: { frameRate: 'variable', resolution: 'variable', ingestionType: 'rtmp' },
    contentDetails: { isReusable: true },
  });
  const info = stream.cdn.ingestionInfo;
  return updateOutput(channelId, output.id, (o) => {
    o.streamId = stream.id;
    o.ingestUrl = `${info.ingestionAddress}/${info.streamName}`;
  });
}

// One reusable stream can have several broadcasts bound to it, and YouTube
// starts whichever it picks when video arrives - so a broadcast left waiting
// from an earlier stream would steal the video from the new one. These keep
// only the current broadcast alive.
const LIVE_STATES = ['live', 'liveStarting'];
const WAITING_STATES = ['created', 'ready', 'testing', 'testStarting'];

async function broadcastsOnStream(accessToken, streamId) {
  const found = [];
  for (const status of ['upcoming', 'active']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await apiCall(accessToken, 'GET',
      `/liveBroadcasts?part=id,status,contentDetails&maxResults=50&broadcastStatus=${status}`);
    (res.items || []).forEach((b) => {
      if (b.contentDetails && b.contentDetails.boundStreamId === streamId) found.push(b);
    });
  }
  return found;
}

// Ends a broadcast that went live, or deletes one that never did (so it
// doesn't linger as an empty "upcoming" video on the channel).
async function endBroadcast(accessToken, broadcast) {
  const state = broadcast.status && broadcast.status.lifeCycleStatus;
  if (LIVE_STATES.includes(state)) {
    await apiCall(accessToken, 'POST',
      `/liveBroadcasts/transition?broadcastStatus=complete&id=${encodeURIComponent(broadcast.id)}&part=status`);
    return 'ended';
  }
  if (WAITING_STATES.includes(state)) {
    await apiCall(accessToken, 'DELETE', `/liveBroadcasts?id=${encodeURIComponent(broadcast.id)}`);
    return 'deleted';
  }
  return null; // already complete (e.g. YouTube's own auto-stop got there first)
}

function broadcastSnippet(channel, scheduledStartTime) {
  // YouTube limits: title 100 characters, description 5000; no < or >.
  const clean = (text) => String(text || '').replace(/[<>]/g, '');
  return {
    title: clean(channel.title || channel.name).slice(0, 100) || 'Live stream',
    description: clean(channel.description).slice(0, 5000),
    scheduledStartTime,
  };
}

// Converts the channel's active Live thumbnail to a 1280px-wide JPEG under
// YouTube's 2MB limit (the app accepts uploads up to 5MB) and sets it on the
// broadcast. Needs a phone-verified YouTube channel; failures are reported,
// not fatal.
async function setThumbnail(accessToken, broadcastId, channel) {
  if (!channel.activeLiveThumbnail) return null;
  const source = path.join(UPLOADS_DIR, path.basename(channel.activeLiveThumbnail));
  if (!fs.existsSync(source)) return null;
  const converted = path.join(os.tmpdir(), `yt-thumb-${crypto.randomUUID()}.jpg`);
  try {
    await new Promise((resolve, reject) => {
      execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', source, '-vf', 'scale=1280:-2', '-q:v', '3', converted],
        (err) => (err ? reject(new Error('Could not convert the thumbnail image.')) : resolve()));
    });
    const res = await fetch(`${YOUTUBE_UPLOAD_API}/thumbnails/set?videoId=${encodeURIComponent(broadcastId)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'image/jpeg' },
      body: fs.readFileSync(converted),
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 403) return 'thumbnail not set - custom thumbnails need a verified YouTube channel (studio.youtube.com → Settings → Channel → Feature eligibility)';
      return `thumbnail not set (${res.status}): ${text.slice(0, 200)}`;
    }
    return null;
  } catch (err) {
    return `thumbnail not set: ${err.message}`;
  } finally {
    fs.rm(converted, { force: true }, () => {});
  }
}

// Called when the channel starts publishing. `session` identifies this
// publish, so a slow response can't attach a broadcast to a later stream or
// to one that has already ended.
async function startBroadcast(channelId, outputId, session) {
  try {
    const accessToken = await accessTokenFor(outputId);
    let db = readDb();
    let channel = db.channels[channelId];
    let output = channel && channel.outputs.find((o) => o.id === outputId);
    if (!output || output.session !== session) return;

    output = await ensureStream(accessToken, channelId, output);

    // A quick reconnect (OBS dropped out for a moment) carries on in the same
    // broadcast if it's still live; anything else on this stream is ended or
    // deleted so the video can only go to one broadcast.
    const existing = await broadcastsOnStream(accessToken, output.streamId);
    const recent = output.previousBroadcastId && output.previousEndedAt
      && Date.now() - new Date(output.previousEndedAt).getTime() < RECONNECT_GRACE_MS;
    const resumable = recent && existing.find((b) => b.id === output.previousBroadcastId
      && LIVE_STATES.includes(b.status.lifeCycleStatus));
    for (const b of existing) {
      if (resumable && b.id === resumable.id) continue;
      // eslint-disable-next-line no-await-in-loop
      await endBroadcast(accessToken, b).catch((err) => console.error(`[youtube] Couldn't clear broadcast ${b.id}: ${err.message}`));
    }

    let broadcast = resumable;
    if (!broadcast) {
      broadcast = await apiCall(accessToken, 'POST', '/liveBroadcasts?part=snippet,status,contentDetails', {
        snippet: broadcastSnippet(channel, new Date().toISOString()),
        status: { privacyStatus: PRIVACY_STATUSES.includes(output.privacyStatus) ? output.privacyStatus : 'public', selfDeclaredMadeForKids: false },
        contentDetails: { enableAutoStart: true, enableAutoStop: true, monitorStream: { enableMonitorStream: false } },
      });
      await apiCall(accessToken, 'POST',
        `/liveBroadcasts/bind?id=${encodeURIComponent(broadcast.id)}&part=id&streamId=${encodeURIComponent(output.streamId)}`);
    }

    db = readDb();
    channel = db.channels[channelId];
    const fresh = channel && channel.outputs.find((o) => o.id === outputId);
    if (!fresh || fresh.session !== session) return; // stream ended meanwhile
    // Setting broadcastId is what releases the relay - see relay-targets.
    updateOutput(channelId, outputId, (o) => {
      o.broadcastId = broadcast.id;
      o.previousBroadcastId = null;
      o.previousEndedAt = null;
    });

    if (resumable) {
      setStatus(channelId, outputId, true, 'Reconnected - carrying on in the same YouTube broadcast', { url: `https://youtu.be/${broadcast.id}` });
      return;
    }
    const thumbnailProblem = await setThumbnail(accessToken, broadcast.id, channel);
    setStatus(channelId, outputId, !thumbnailProblem, thumbnailProblem ? `Live on YouTube, but the ${thumbnailProblem}` : 'Live on YouTube',
      { url: `https://youtu.be/${broadcast.id}` });
  } catch (err) {
    console.error(`[youtube] Channel ${channelId} output ${outputId}: ${err.message}`);
    setStatus(channelId, outputId, false,
      err.reconnect ? 'YouTube needs reconnecting - delete this output and add YouTube again.' : err.message);
  }
}

// Called RECONNECT_GRACE_MS after the stream stops (see rtmpHooks.js). If it
// hasn't come back by then, the broadcast is ended now rather than left to
// YouTube's own auto-stop (which can take minutes), and one that never went
// live is deleted. Long enough for OBS's automatic reconnect to carry on in
// the same broadcast; a dropped connection (rather than a clean stop) is only
// noticed after nginx's drop_idle_publisher 10s anyway.
const RECONNECT_GRACE_MS = Number(process.env.YOUTUBE_RECONNECT_GRACE_MS) || 15 * 1000;

async function finishBroadcast(channelId, outputId, broadcastId) {
  const channel = readDb().channels[channelId];
  const output = channel && (channel.outputs || []).find((o) => o.id === outputId);
  if (!output || output.session || output.previousBroadcastId !== broadcastId) return; // live again, or already handled
  try {
    const accessToken = await accessTokenFor(outputId);
    const res = await apiCall(accessToken, 'GET', `/liveBroadcasts?part=id,status&id=${encodeURIComponent(broadcastId)}`);
    const broadcast = res.items && res.items[0];
    const done = broadcast ? await endBroadcast(accessToken, broadcast) : null;
    setStatus(channelId, outputId, true,
      done === 'deleted' ? 'Stream ended - the YouTube broadcast never went live, so it was removed' : 'Stream ended - YouTube broadcast ended');
  } catch (err) {
    console.error(`[youtube] Ending broadcast ${broadcastId}: ${err.message}`);
    setStatus(channelId, outputId, false,
      `Stream ended, but the YouTube broadcast couldn't be ended (YouTube will end it itself shortly): ${err.message}`);
  }
  updateOutput(channelId, outputId, (o) => {
    if (o.previousBroadcastId !== broadcastId) return;
    o.previousBroadcastId = null;
    o.previousEndedAt = null;
  });
}

// A different Live thumbnail picked mid-stream: set it on the broadcast
// that's live right now, if any.
async function updateBroadcastThumbnail(channelId) {
  const channel = readDb().channels[channelId];
  if (!channel || !channel.activeLiveThumbnail) return;
  const outputs = (channel.outputs || []).filter((o) => o.type === 'youtube' && o.broadcastId);
  for (const output of outputs) {
    const url = `https://youtu.be/${output.broadcastId}`;
    try {
      // eslint-disable-next-line no-await-in-loop
      const accessToken = await accessTokenFor(output.id);
      // eslint-disable-next-line no-await-in-loop
      const problem = await setThumbnail(accessToken, output.broadcastId, channel);
      if (problem) setStatus(channelId, output.id, false, `Live on YouTube, but the ${problem}`, { url });
      else setStatus(channelId, output.id, true, 'Live on YouTube - thumbnail updated', { url });
    } catch (err) {
      console.error(`[youtube] Thumbnail update for ${channelId}/${output.id}: ${err.message}`);
      setStatus(channelId, output.id, false, `Couldn't update the YouTube thumbnail: ${err.message}`, { url });
    }
  }
}

// Title/description edited mid-stream (and "Send title" style updates):
// pushed to the current broadcast, if there is one.
async function updateBroadcastDetails(channelId) {
  const channel = readDb().channels[channelId];
  if (!channel) return;
  const outputs = (channel.outputs || []).filter((o) => o.type === 'youtube' && o.broadcastId);
  for (const output of outputs) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const accessToken = await accessTokenFor(output.id);
      // eslint-disable-next-line no-await-in-loop
      const current = await apiCall(accessToken, 'GET', `/liveBroadcasts?part=snippet&id=${encodeURIComponent(output.broadcastId)}`);
      const item = current.items && current.items[0];
      if (!item) continue;
      // eslint-disable-next-line no-await-in-loop
      await apiCall(accessToken, 'PUT', '/liveBroadcasts?part=snippet', {
        id: output.broadcastId,
        snippet: broadcastSnippet(channel, item.snippet.scheduledStartTime),
      });
      setStatus(channelId, output.id, true, `Live on YouTube - title updated to ${broadcastSnippet(channel).title}`,
        { url: `https://youtu.be/${output.broadcastId}` });
    } catch (err) {
      console.error(`[youtube] Title update for ${channelId}/${output.id}: ${err.message}`);
      setStatus(channelId, output.id, false, `Couldn't update the YouTube title: ${err.message}`,
        { url: `https://youtu.be/${output.broadcastId}` });
    }
  }
}

module.exports = {
  isConfigured,
  getAuthUrl,
  connect,
  forget,
  startBroadcast,
  finishBroadcast,
  updateBroadcastDetails,
  updateBroadcastThumbnail,
  RECONNECT_GRACE_MS,
  PRIVACY_STATUSES,
};
