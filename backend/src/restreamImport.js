// Backs the Stats page's "Import from Restream" flow: preview a date range
// (read-only - hits Restream's API, writes nothing locally) and commit a
// (possibly admin-corrected) list of the preview's rows into plays.js.
//
// The exact shape of Restream's event-history and per-event-analytics
// responses assumed below is NOT independently verified against the live
// API (see restream.js's top comment) - extractPlatformViews() in
// particular is the thing most likely to need adjusting once this is
// tested against a real connected account, since it's guessing at how
// Restream names/nests a YouTube vs Facebook destination within an event's
// analytics.

const { readDb } = require('./db');
const restream = require('./restream');
const { matchChannelForEvent } = require('./restreamMatch');
const plays = require('./plays');

async function getAccessToken() {
  const db = readDb();
  if (!db.restream || !db.restream.refreshToken) {
    throw new Error('Restream is not connected - connect it first from the Stats page.');
  }
  const tokens = await restream.refreshAccessToken(db.restream.refreshToken);
  return tokens.access_token;
}

// Assumed shape: analytics.channels is an array of per-destination entries,
// each carrying some identifying platform name (exact field/casing
// unverified - checked loosely across the couple of plausible field names)
// and a views/total-views count for that destination.
function extractPlatformViews(analytics, platformName) {
  const channels = (analytics && (analytics.channels || analytics.destinations)) || [];
  const entry = channels.find((c) => {
    const label = String(c.platform || c.service || c.type || '').toLowerCase();
    return label.includes(platformName);
  });
  if (!entry) return 0;
  return Number(entry.views ?? entry.totalViews ?? entry.viewCount ?? 0) || 0;
}

async function previewImport({ from, to }) {
  const accessToken = await getAccessToken();
  const events = await restream.listEventHistory(accessToken, { from, to });
  const db = readDb();

  const results = [];
  for (const event of events) {
    const startedAt = event.startTime || event.scheduledFor || event.createdAt;
    const finishedAt = event.endTime || null;

    // eslint-disable-next-line no-await-in-loop
    const analytics = await restream.getEventAnalytics(accessToken, event.id);
    const youtubeViews = extractPlatformViews(analytics, 'youtube');
    const facebookViews = extractPlatformViews(analytics, 'facebook');
    if (!youtubeViews && !facebookViews) continue; // nothing relevant to this event

    const matchedChannelId = matchChannelForEvent({ startedAt, finishedAt });
    const matchedChannel = matchedChannelId ? db.channels[matchedChannelId] : null;

    results.push({
      restreamEventId: event.id,
      restreamTitle: event.title || '',
      startedAt,
      finishedAt,
      channelId: matchedChannelId,
      channelName: matchedChannel ? matchedChannel.name : null,
      needsManualChannel: !matchedChannelId,
      youtubeViews,
      facebookViews,
    });
  }
  return results;
}

// items: the (possibly admin-corrected, e.g. a manually picked channelId
// for a needsManualChannel row) list from previewImport(). Anything still
// missing a channelId at this point is skipped rather than guessed at.
function commitImport(items) {
  const db = readDb();
  const rows = [];

  items.forEach((item) => {
    const channel = item.channelId ? db.channels[item.channelId] : null;
    if (!channel) return;

    const common = {
      channelId: channel.id,
      channelName: channel.name,
      title: channel.title || channel.name,
      description: channel.description || '',
      firstPlayAt: item.startedAt,
      latestPlayAt: item.finishedAt || item.startedAt,
      restreamEventId: item.restreamEventId,
    };
    if (item.youtubeViews) rows.push(Object.assign({}, common, { platform: 'youtube', views: item.youtubeViews }));
    if (item.facebookViews) rows.push(Object.assign({}, common, { platform: 'facebook', views: item.facebookViews }));
  });

  return plays.upsertImportedPlays(rows);
}

module.exports = { previewImport, commitImport };
