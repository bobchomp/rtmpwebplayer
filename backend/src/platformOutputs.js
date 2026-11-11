// Shared by youtube.js and facebook.js, whose outputs have the same shape
// (session, broadcastId, ingestUrl, previousBroadcastId, lastStatus) so the
// go-live/stop hooks and the relay treat them alike - see rtmpHooks.js.

const { readDb, writeDb } = require('./db');

// How long after the stream stops before the platform's broadcast is ended.
// Long enough for OBS's automatic reconnect to carry on in the same
// broadcast; a dropped connection (rather than a clean stop) is only noticed
// after nginx's drop_idle_publisher 10s anyway.
const RECONNECT_GRACE_MS = Number(process.env.YOUTUBE_RECONNECT_GRACE_MS) || 15 * 1000;

// Updates one output in place (re-reading the db, since these run detached
// from any request and the network calls take a while).
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

module.exports = { RECONNECT_GRACE_MS, updateOutput, setStatus };
