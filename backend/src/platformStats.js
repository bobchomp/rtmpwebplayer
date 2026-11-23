// Stats for the direct YouTube/Facebook outputs, replacing the Restream
// import. Every broadcast the app creates is recorded in
// db.platformBroadcasts (keyed `${platform}-${broadcastId}`), so views are
// asked of YouTube/Facebook for exactly that broadcast - no guessing which
// channel a stream belonged to.
//
// - While live: viewers watching right now are sampled every minute, giving
//   a peak and an average live audience.
// - After it ends: total views (which keep growing as people watch the
//   replay) are refreshed 10 minutes later, then daily for a week, then
//   weekly until five weeks after. YouTube also gives views by country.
//
// Each broadcast becomes Stats rows (plays.js) with deterministic ids: one
// total row (`direct-<platform>-<id>`, Country "All") and, for YouTube, one
// row per country (`direct-youtube-<id>-<CC>`, breakdown: 'country'). The
// country rows add up to the total, so the Template export counts only the
// total rows.
//
// The platform clients (youtube.js/facebook.js) register themselves here
// with fetchers, rather than this module requiring them, to avoid a circular
// require (they call registerBroadcast etc.).

const { readDb, writeDb } = require('./db');
const plays = require('./plays');

const SAMPLE_INTERVAL_MS = 60 * 1000;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const REFRESH_FIRST_MS = 10 * MINUTE;
const STOP_REFRESHING_AFTER_MS = 35 * DAY;

const clients = {};

// client: { liveViewers(record) -> number|null, views(record) -> { views, countries? } }
function registerClient(platform, client) {
  clients[platform] = client;
}

function keyFor(platform, broadcastId) {
  return `${platform}-${broadcastId}`;
}

function rowPrefix(record) {
  return `direct-${record.platform}-${record.broadcastId}`;
}

let countryNames = null;
function countryName(code) {
  try {
    countryNames = countryNames || new Intl.DisplayNames(['en-GB'], { type: 'region' });
    return countryNames.of(code) || code;
  } catch (err) {
    return code;
  }
}

function buildRows(record) {
  if (record.excluded) return [];
  const live = record.live || {};
  const common = {
    owner: record.owner,
    channelId: record.channelId,
    channelName: record.channelName,
    title: record.title,
    description: record.description || '',
    platform: record.platform,
    firstPlayAt: record.startedAt,
    latestPlayAt: record.endedAt || record.startedAt,
  };
  const rows = [Object.assign({}, common, {
    id: rowPrefix(record),
    views: record.views != null ? record.views : null,
    peakLiveViewers: live.count ? live.peak : null,
    avgLiveViewers: live.count ? Math.round(live.sum / live.count) : null,
    country: 'All',
    url: record.url || null,
  })];
  Object.entries(record.countryViews || {}).forEach(([code, views]) => {
    if (!views || (record.excludedCountries || []).includes(code)) return;
    rows.push(Object.assign({}, common, {
      id: `${rowPrefix(record)}-${code}`,
      views,
      country: countryName(code),
      breakdown: 'country',
    }));
  });
  return rows;
}

function saveRecord(record) {
  const db = readDb();
  db.platformBroadcasts = db.platformBroadcasts || {};
  db.platformBroadcasts[keyFor(record.platform, record.broadcastId)] = record;
  writeDb(db);
  plays.replaceDirectRows(rowPrefix(record), buildRows(record));
}

function getRecord(platform, broadcastId) {
  const db = readDb();
  return (db.platformBroadcasts || {})[keyFor(platform, broadcastId)] || null;
}

// Called once a new broadcast is ready (not on a reconnect that carries on
// in the same one). `account` is the YouTube channel / Facebook Page id, so
// any later connection to the same account can still refresh its views even
// if this output has been deleted and re-added.
function registerBroadcast({ platform, broadcastId, channel, account, url }) {
  if (getRecord(platform, broadcastId)) return;
  saveRecord({
    platform,
    broadcastId,
    account,
    channelId: channel.id,
    owner: channel.owner,
    channelName: channel.name,
    title: channel.title || channel.name,
    description: channel.description || '',
    url: url || null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    live: { peak: 0, sum: 0, count: 0 },
    views: null,
    countryViews: null,
    lastRefreshedAt: null,
    lastError: null,
    nextRefreshAt: null,
  });
}

// Mid-stream title/description edits - the stats rows show the latest.
function updateDetails(platform, broadcastId, channel) {
  const record = getRecord(platform, broadcastId);
  if (!record) return;
  record.title = channel.title || channel.name;
  record.description = channel.description || '';
  saveRecord(record);
}

// neverWentLive: the broadcast was deleted on the platform because no video
// ever reached it - nothing to report, so no rows.
function markEnded(platform, broadcastId, { neverWentLive } = {}) {
  const record = getRecord(platform, broadcastId);
  if (!record || record.endedAt) return;
  record.endedAt = new Date().toISOString();
  if (neverWentLive) record.excluded = true;
  record.nextRefreshAt = new Date(Date.now() + REFRESH_FIRST_MS).toISOString();
  saveRecord(record);
}

// Daily for the first week after the broadcast ends, then weekly, then stop.
function nextRefreshAfter(record) {
  const sinceEnd = Date.now() - new Date(record.endedAt).getTime();
  if (sinceEnd >= STOP_REFRESHING_AFTER_MS) return null;
  const gap = sinceEnd < 7 * DAY ? DAY : 7 * DAY;
  return new Date(Date.now() + gap).toISOString();
}

async function refresh(record) {
  const client = clients[record.platform];
  if (!client) return record;
  try {
    const result = await client.views(record);
    record.views = result.views != null ? result.views : record.views;
    if (result.countries) record.countryViews = result.countries;
    record.lastError = result.warning || null;
  } catch (err) {
    console.error(`[platform-stats] Refreshing ${record.platform} ${record.broadcastId}: ${err.message}`);
    record.lastError = err.message;
  }
  record.lastRefreshedAt = new Date().toISOString();
  if (record.endedAt) record.nextRefreshAt = nextRefreshAfter(record);
  saveRecord(record);
  return record;
}

// Live broadcasts are the ones an output currently points at.
function liveRecords() {
  const db = readDb();
  const live = [];
  Object.values(db.channels || {}).forEach((channel) => {
    (channel.outputs || []).forEach((o) => {
      if (!clients[o.type] || !o.session || !o.broadcastId) return;
      const record = (db.platformBroadcasts || {})[keyFor(o.type, o.broadcastId)];
      if (record && !record.endedAt) live.push(record);
    });
  });
  return live;
}

async function sampleLiveViewers(channelId) {
  for (const record of liveRecords().filter((r) => !channelId || r.channelId === channelId)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const viewers = await clients[record.platform].liveViewers(record);
      if (viewers == null) continue;
      const fresh = getRecord(record.platform, record.broadcastId);
      if (!fresh || fresh.endedAt) continue;
      fresh.live = fresh.live || { peak: 0, sum: 0, count: 0 };
      fresh.live.peak = Math.max(fresh.live.peak, viewers);
      fresh.live.sum += viewers;
      fresh.live.count += 1;
      fresh.live.current = viewers;
      fresh.live.currentAt = new Date().toISOString();
      saveRecord(fresh);
    } catch (err) {
      console.error(`[platform-stats] Live viewers for ${record.platform} ${record.broadcastId}: ${err.message}`);
    }
  }
}

async function refreshDue() {
  const db = readDb();
  const now = Date.now();
  const due = Object.values(db.platformBroadcasts || {})
    .filter((r) => !r.excluded && r.nextRefreshAt && new Date(r.nextRefreshAt).getTime() <= now);
  for (const record of due) {
    // eslint-disable-next-line no-await-in-loop
    await refresh(record);
  }
}

// The Stats page's "Refresh now" button: every broadcast of this account's
// that ended in the last five weeks, or is live.
async function refreshNow(owner) {
  const db = readDb();
  const cutoff = Date.now() - STOP_REFRESHING_AFTER_MS;
  const records = Object.values(db.platformBroadcasts || {}).filter((r) => r.owner === owner && !r.excluded
    && (!r.endedAt || new Date(r.endedAt).getTime() >= cutoff));
  const problems = [];
  for (const record of records) {
    // eslint-disable-next-line no-await-in-loop
    const updated = await refresh(record);
    if (updated.lastError) problems.push(`${updated.title} (${updated.platform}): ${updated.lastError}`);
  }
  return { refreshed: records.length, problems };
}

// Rows deleted on the Stats page stay deleted when views are refreshed:
// deleting a broadcast's total row drops the whole broadcast; deleting a
// country row drops just that country.
function excludeRows(ids, owner) {
  const db = readDb();
  let changed = false;
  Object.values(db.platformBroadcasts || {}).forEach((record) => {
    if (record.owner !== owner || record.excluded) return;
    const prefix = rowPrefix(record);
    ids.forEach((id) => {
      if (id === prefix) {
        record.excluded = true;
        changed = true;
      } else if (id.startsWith(`${prefix}-`)) {
        record.excludedCountries = (record.excludedCountries || []).concat(id.slice(prefix.length + 1));
        changed = true;
      }
    });
  });
  if (changed) writeDb(db);
}

// The most recent "watching now" sample for a live broadcast, for the
// dashboard. Null once it's more than a few minutes old.
function currentViewers(platform, broadcastId) {
  const record = getRecord(platform, broadcastId);
  const live = record && !record.endedAt && record.live;
  if (!live || live.current == null || !live.currentAt) return null;
  if (Date.now() - new Date(live.currentAt).getTime() > 3 * MINUTE) return null;
  return live.current;
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    await sampleLiveViewers();
    await refreshDue();
  } finally {
    running = false;
  }
}

if (process.env.NODE_ENV !== 'test') setInterval(tick, SAMPLE_INTERVAL_MS).unref();

module.exports = {
  registerClient,
  registerBroadcast,
  updateDetails,
  markEnded,
  refreshNow,
  excludeRows,
  currentViewers,
  sampleLiveViewers,
  tick,
};
