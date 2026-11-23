// Starting and ending a direct YouTube/Facebook output's broadcast, shared
// by the RTMP hooks (the encoder connecting or disconnecting) and the
// output switches on the channel page (turned on or off mid-stream).
//
// Both functions only change the output in the db object they're given;
// the caller writes it, then runs the function they return (if any), so the
// new session is saved before the platform client goes looking for it.

const { readDb, writeDb } = require('./db');
const youtube = require('./youtube');
const facebook = require('./facebook');
const crypto = require('crypto');

const PLATFORMS = {
  youtube: { client: youtube, name: 'YouTube broadcast' },
  facebook: { client: facebook, name: 'Facebook live video' },
};

// The encoder is connected. `publishing` is set by the RTMP hooks; isLive
// covers channels already live when this field was added.
function isPublishing(channel) {
  return channel.publishing === true || channel.isLive === true;
}

// A fresh session, and the broadcast created for it. Returns the function
// that starts it, or null if this output can't start.
function beginOutput(channel, output) {
  const platform = PLATFORMS[output.type];
  if (!platform) return null;
  output.session = null;
  output.broadcastId = null;
  if (!output.enabled || !platform.client.isConfigured()) return null;
  const session = crypto.randomUUID();
  output.session = session;
  output.lastStatus = { at: new Date().toISOString(), ok: true, message: `Starting the ${platform.name}...` };
  return () => platform.client.startBroadcast(channel.id, output.id, session);
}

// Stops sending to the broadcast. It's ended after a short grace period, so
// a quick reconnect (or switching back on) carries on in the same one.
function endOutput(channel, output, message) {
  const platform = PLATFORMS[output.type];
  if (!platform || !output.session) return null;
  const broadcastId = output.broadcastId;
  output.session = null;
  output.broadcastId = null;
  if (output.lastStatus && output.lastStatus.ok) {
    output.lastStatus = { at: new Date().toISOString(), ok: true, message };
  }
  if (!broadcastId) return null;
  output.previousBroadcastId = broadcastId;
  output.previousEndedAt = new Date().toISOString();
  return () => setTimeout(
    () => platform.client.finishBroadcast(channel.id, output.id, broadcastId),
    platform.client.RECONNECT_GRACE_MS
  );
}

// After an output's switch changes: start or end its broadcast if the
// encoder is connected right now. Custom RTMP outputs need nothing here;
// the relay picks the change up by itself (rtmp/relay-start.sh).
function applySwitch(channel, output) {
  if (!PLATFORMS[output.type] || !isPublishing(channel)) return null;
  if (output.enabled && !output.session) return beginOutput(channel, output);
  if (!output.enabled && output.session) return endOutput(channel, output, 'Switched off');
  return null;
}

// A YouTube/Facebook output added while the channel is already streaming
// starts straight away rather than waiting for the next stream.
function startIfLive(channelId, outputId) {
  const db = readDb();
  const channel = db.channels[channelId];
  const output = channel && (channel.outputs || []).find((o) => o.id === outputId);
  if (!output) return;
  const run = applySwitch(channel, output);
  if (!run) return;
  writeDb(db);
  run();
}

module.exports = { PLATFORMS, isPublishing, beginOutput, endOutput, applySwitch, startIfLive };
