// Backs the Stats page's "Import from Restream" flow: preview a date range
// (read-only - hits Restream's API, writes nothing locally) and commit a
// (possibly admin-corrected) list of the preview's rows into plays.js.
//
// Platform detection (YouTube vs Facebook) is read straight off each
// event's destinations[].externalUrl, since that's given directly on the
// event and avoids an extra API call. If a destination has no externalUrl,
// this falls back to the account's channel list (GET /user/channels),
// fetched lazily and cached for the rest of the preview call, checking its
// channelUrl instead.
//
// /user/events/history's from/to query params don't actually filter the
// response (confirmed against a live account - it just returns full
// history regardless), so the requested range is enforced here instead,
// before any per-event analytics calls are made.

const { readDb } = require('./db');
const restream = require('./restream');
const { getAccessToken } = require('./restreamSession');
const { matchChannelForEvent } = require('./restreamMatch');
const plays = require('./plays');

function toIso(epochSeconds) {
  if (epochSeconds === null || epochSeconds === undefined) return null;
  return new Date(epochSeconds * 1000).toISOString();
}

function viewsForChannel(byChannel, channelId) {
  const entry = (byChannel && (byChannel[channelId] || byChannel[String(channelId)])) || null;
  return entry ? Number(entry.viewsTotal) || 0 : 0;
}

async function previewImport({ from, to }) {
  const accessToken = await getAccessToken();
  const allEvents = await restream.listEventHistory(accessToken, { from, to });
  const db = readDb();

  const fromMs = from ? new Date(from).getTime() : -Infinity;
  const toMs = to ? new Date(to).getTime() : Infinity;
  const events = allEvents.filter((event) => {
    const ts = event.startedAt ?? event.scheduledFor;
    if (typeof ts !== 'number') return false;
    const ms = ts * 1000;
    return ms >= fromMs && ms <= toMs;
  });

  let channelsCache = null;
  async function resolvePlatform(channelId, externalUrl) {
    const direct = restream.platformFromUrl(externalUrl);
    if (direct) return direct;
    if (!channelsCache) {
      const res = await restream.listChannels(accessToken);
      channelsCache = (res && res.channels) || [];
    }
    const match = channelsCache.find((c) => c.id === channelId);
    return match ? restream.platformFromUrl(match.channelUrl) : null;
  }

  const results = [];
  for (const event of events) {
    const startedAt = toIso(event.startedAt) || toIso(event.scheduledFor);
    const finishedAt = toIso(event.finishedAt);
    const destinations = event.destinations || [];

    let youtubeViews = 0;
    let facebookViews = 0;
    if (destinations.length) {
      // eslint-disable-next-line no-await-in-loop
      const analytics = await restream.getEventAnalytics(accessToken, event.id).catch(() => null);
      const byChannel = (analytics && analytics.byChannel) || {};
      // eslint-disable-next-line no-restricted-syntax
      for (const dest of destinations) {
        // eslint-disable-next-line no-await-in-loop
        const platform = await resolvePlatform(dest.channelId, dest.externalUrl);
        if (!platform) continue; // custom RTMP or unrecognized destination
        const views = viewsForChannel(byChannel, dest.channelId);
        if (platform === 'youtube') youtubeViews += views;
        else if (platform === 'facebook') facebookViews += views;
      }
    }
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
//
// Logs every skip with its reason, and returns counts rather than just a
// single number - the commit button used to give no feedback at all beyond
// "no error was thrown", which made a silent 0-rows-written commit
// indistinguishable from a successful one in the UI.
function commitImport(items) {
  const db = readDb();
  const rows = [];
  let skippedNoChannel = 0;
  let skippedNoViews = 0;

  items.forEach((item) => {
    const channel = item.channelId ? db.channels[item.channelId] : null;
    if (!channel) {
      skippedNoChannel += 1;
      console.warn(`[restream-import] Skipping event ${item.restreamEventId} - no channel (channelId=${item.channelId})`);
      return;
    }
    if (!item.youtubeViews && !item.facebookViews) {
      skippedNoViews += 1;
      console.warn(`[restream-import] Skipping event ${item.restreamEventId} for ${channel.name} - no YouTube/Facebook views`);
      return;
    }

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

  const importedCount = plays.upsertImportedPlays(rows);
  console.log(`[restream-import] Committed ${importedCount} row(s) from ${items.length} event(s) - skipped ${skippedNoChannel} (no channel), ${skippedNoViews} (no views).`);
  return { importedCount, itemCount: items.length, skippedNoChannel, skippedNoViews };
}

module.exports = { previewImport, commitImport };
