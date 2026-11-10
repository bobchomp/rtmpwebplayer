// Sends a channel's title/description to every active destination on its
// owner's Restream account (YouTube, Facebook, ...), via Restream's
// channel-meta endpoint. Opt-in per channel (channel.restreamTitleSync),
// since one Restream account can only carry one title at a time and an
// account may have several channels here.
//
// Runs when the channel goes live (routes/rtmpHooks.js), and when the title
// is saved or the setting is switched on (routes/channels.js). The outcome
// is stored on the channel as `restreamTitleSyncStatus` for the dashboard.

const { readDb, writeDb } = require('./db');
const restream = require('./restream');
const { getAccessToken } = require('./restreamSession');

function canSendTitles(connection) {
  return !!(connection && connection.refreshToken
    && (connection.scope || '').split(' ').includes('channels.write'));
}

// Restream's answer for destinations that have nowhere to show a title,
// such as a custom RTMP server - skipped rather than reported as failures.
function titlesNotSupported(err) {
  return err.status === 400 && /TitlesNotSupported/.test(err.name);
}

function describeError(err) {
  if (err.status === 401 || err.status === 403) {
    return 'Restream refused the update. Reconnect Restream (on the channel page or Stats page) to allow title updates.';
  }
  return err.message;
}

async function sendTitles(channel) {
  const db = readDb();
  const connection = db.restreamAccounts && db.restreamAccounts[channel.owner];
  if (!connection || !connection.refreshToken) {
    throw new Error('Restream is not connected - connect it on the channel page or Stats page.');
  }
  if (!canSendTitles(connection)) {
    throw new Error('Restream needs reconnecting to allow title updates - click Reconnect in the Restream section of the channel page.');
  }

  const accessToken = await getAccessToken(channel.owner);
  const destinations = (await restream.listChannelsWithStatus(accessToken))
    .filter((d) => d.enabled);
  if (!destinations.length) throw new Error('No active destinations on Restream.');

  // Titles are stored wrapped in quotes by convention (see channels.js), and
  // a channel with no title yet falls back to its name.
  const title = channel.title || channel.name;
  const sentTo = [];
  const failures = [];
  const mismatches = [];
  for (const destination of destinations) {
    // Accounts often use the same name on every platform, so say which.
    const platform = { youtube: 'YouTube', facebook: 'Facebook' }[restream.platformFromUrl(destination.url)];
    const baseName = destination.displayName || String(destination.id);
    const name = platform ? `${baseName} (${platform})` : baseName;
    try {
      // eslint-disable-next-line no-await-in-loop
      await restream.updateChannelMeta(accessToken, destination.id, { title, description: channel.description });
      sentTo.push(name);
      // Read it back, since Restream answers the update with an empty body
      // and its own screens don't always show the result.
      // eslint-disable-next-line no-await-in-loop
      const stored = await restream.getChannelMeta(accessToken, destination.id).catch(() => null);
      if (stored && stored.title !== title) mismatches.push(`${name} reports "${stored.title}"`);
    } catch (err) {
      if (!titlesNotSupported(err)) failures.push(`${name}: ${describeError(err)}`);
    }
  }
  if (!sentTo.length) throw new Error(failures.join(' ') || 'None of your active Restream destinations support titles.');
  if (mismatches.length) failures.push(`Restream didn't keep the new title: ${mismatches.join(', ')}.`);
  return { sent: sentTo.length, destinations: sentTo, warning: failures.length ? failures.join(' ') : null };
}

// Never throws - failures are recorded on the channel instead, so a Restream
// problem can't break saving a title or going live.
async function syncChannelTitle(channelId) {
  const channel = readDb().channels[channelId];
  if (!channel || !channel.restreamTitleSync) return null;

  let status;
  try {
    const result = await sendTitles(channel);
    status = { at: new Date().toISOString(), ok: true, title: channel.title || channel.name, ...result };
  } catch (err) {
    status = { at: new Date().toISOString(), ok: false, error: describeError(err) };
    console.error(`[restream-title-sync] Channel ${channelId}: ${status.error}`);
  }

  // Re-read: the network calls above take a moment and the db may have
  // changed meanwhile.
  try {
    const db = readDb();
    if (db.channels[channelId]) {
      db.channels[channelId].restreamTitleSyncStatus = status;
      writeDb(db);
    }
  } catch (err) {
    console.error(`[restream-title-sync] Failed to save status for ${channelId}:`, err.message);
  }
  return status;
}

module.exports = { syncChannelTitle, canSendTitles };
