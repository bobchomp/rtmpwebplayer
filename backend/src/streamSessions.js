// The channel page's viewer graph and "Last stream" summary.
//
// Each channel keeps its latest stream in db.streamSessions[channelId]:
// when it started and ended, and once a minute how many were watching on
// each source (Your website, Public Link, YouTube, Facebook). A reconnect
// within a few minutes carries on in the same stream rather than starting
// a new one. Only the latest stream is kept; the Stats page has the history.

const { readDb, writeDb } = require('./db');
const plays = require('./plays');
const platformStats = require('./platformStats');

const SAMPLE_INTERVAL_MS = 60 * 1000;
const RESUME_WITHIN_MS = 3 * 60 * 1000;
const MAX_SAMPLES = 24 * 60;
const PLATFORM_NAMES = { youtube: 'YouTube', facebook: 'Facebook' };

// How many are watching on each source right now. Website and Public Link
// come from player heartbeats; YouTube and Facebook from their own live
// viewer numbers (null until the first one arrives). Custom RTMP outputs
// can't be counted, so they're left out.
function currentCounts(channel) {
  const counts = plays.countActiveViewers(channel.id);
  const outputs = {};
  (channel.outputs || []).forEach((o) => {
    if (o.type === 'public-link') outputs[o.id] = counts['public-link'];
    else if (PLATFORM_NAMES[o.type] && o.session && o.broadcastId) {
      outputs[o.id] = platformStats.currentViewers(o.type, o.broadcastId);
    }
  });
  return { website: counts.website, outputs };
}

function sourceName(output) {
  if (output.type === 'public-link') return 'Public Link';
  return PLATFORM_NAMES[output.type] || null;
}

function newSession(startedAt) {
  return { startedAt, endedAt: null, samples: [], sourceNames: { website: 'Your website' } };
}

function takeSample(session, channel) {
  const { website, outputs } = currentCounts(channel);
  const c = { website };
  Object.keys(outputs).forEach((id) => {
    if (outputs[id] != null) c[id] = outputs[id];
  });
  (channel.outputs || []).forEach((o) => {
    const name = sourceName(o);
    if (name && (o.type === 'public-link' || o.session)) session.sourceNames[o.id] = name;
  });
  session.samples.push({ t: new Date().toISOString(), c });
  if (session.samples.length > MAX_SAMPLES) session.samples.splice(0, session.samples.length - MAX_SAMPLES);
}

// Called when the channel actually goes live (rtmpHooks.js).
function start(channelId) {
  const db = readDb();
  const channel = db.channels[channelId];
  if (!channel) return;
  db.streamSessions = db.streamSessions || {};
  const existing = db.streamSessions[channelId];
  if (existing && existing.endedAt && Date.now() - new Date(existing.endedAt).getTime() < RESUME_WITHIN_MS) {
    existing.endedAt = null;
  } else {
    db.streamSessions[channelId] = newSession(new Date().toISOString());
  }
  takeSample(db.streamSessions[channelId], channel);
  writeDb(db);
}

// Called when the encoder disconnects.
function end(channelId) {
  const db = readDb();
  const session = (db.streamSessions || {})[channelId];
  if (!session || session.endedAt) return;
  session.endedAt = new Date().toISOString();
  writeDb(db);
}

function sampleAll() {
  const db = readDb();
  let changed = false;
  Object.values(db.channels || {}).forEach((channel) => {
    if (!channel.isLive) return;
    db.streamSessions = db.streamSessions || {};
    let session = db.streamSessions[channel.id];
    // Live but nothing open, e.g. the app was updated mid-stream.
    if (!session || session.endedAt) {
      session = newSession(channel.lastLiveAt || new Date().toISOString());
      db.streamSessions[channel.id] = session;
    }
    takeSample(session, channel);
    changed = true;
  });
  if (changed) writeDb(db);
}

// Everything the channel page shows: the samples for the graph, plus peaks
// and view totals for the summary.
function summary(channel) {
  const db = readDb();
  const session = (db.streamSessions || {})[channel.id];
  if (!session) return null;

  const startMs = new Date(session.startedAt).getTime();
  const endMs = session.endedAt ? new Date(session.endedAt).getTime() : Date.now();

  const peaks = {};
  session.samples.forEach((s) => {
    Object.keys(s.c).forEach((id) => { peaks[id] = Math.max(peaks[id] || 0, s.c[id]); });
  });
  const sources = Object.keys(session.sourceNames).map((id) => ({
    id, name: session.sourceNames[id], peak: peaks[id] != null ? peaks[id] : null,
  }));

  // One row per viewer per service, for the website player and Public Link.
  const websiteViews = plays.listPlays({ channelId: channel.id, from: new Date(startMs - 60 * 1000).toISOString() })
    .filter((p) => p.platform === 'website' && new Date(p.firstPlayAt).getTime() <= endMs + 60 * 1000).length;

  // YouTube/Facebook broadcasts made for this stream. Their view totals
  // arrive about 10 minutes after the stream ends, then keep updating.
  const platforms = Object.values(db.platformBroadcasts || {})
    .filter((r) => r.channelId === channel.id && !r.excluded
      && new Date(r.startedAt).getTime() >= startMs - 5 * 60 * 1000
      && new Date(r.startedAt).getTime() <= endMs)
    .map((r) => ({
      platform: r.platform,
      name: PLATFORM_NAMES[r.platform] || r.platform,
      views: r.views,
      url: r.url || null,
    }));

  return {
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    live: !session.endedAt,
    durationMs: endMs - startMs,
    title: channel.title || '',
    sources,
    samples: session.samples,
    websiteViews,
    platforms,
  };
}

if (process.env.NODE_ENV !== 'test') {
  setInterval(() => {
    try {
      sampleAll();
    } catch (err) {
      console.error('[stream-sessions] Sampling viewers:', err.message);
    }
  }, SAMPLE_INTERVAL_MS).unref();
}

module.exports = { currentCounts, start, end, sampleAll, summary };
