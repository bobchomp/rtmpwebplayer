// Restream has no idea this app's channels exist - it just sees "a stream
// came in and got relayed to some destinations". So attributing an
// imported Restream event to one of this app's channels has to be done by
// matching timing against whatever local record of "this channel was live
// at time X" already exists. Safe to do by timing alone because only one
// stream is ever active on the connected Restream account at once (if that
// ever changes, this whole approach needs rethinking).
//
// Two sources, in order of reliability:
//   1. recordings.json - exact startedAt/finishedAt per past broadcast,
//      but only exists for channels that had recording turned on.
//   2. plays.json website rows - fuzzier (depends on someone having
//      actually watched during the stream), used only when nothing in
//      recordings.json overlaps.
// Neither is guaranteed to have anything for a given event - the caller
// (restreamImport.js) is expected to flag that case for a manual pick
// rather than silently guessing.

const recordings = require('./recordings');
const plays = require('./plays');

function windowsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && aEnd >= bStart;
}

function matchViaRecordings(eventStartMs, eventEndMs) {
  const overlapping = recordings.listRecordings().filter((r) => {
    const recStart = new Date(r.startedAt).getTime();
    const recEnd = r.finishedAt ? new Date(r.finishedAt).getTime() : recStart;
    return windowsOverlap(recStart, recEnd, eventStartMs, eventEndMs);
  });
  if (!overlapping.length) return null;

  // Should only ever be one distinct channel here (see module comment) -
  // if more than one somehow overlaps, go with whichever recording covers
  // more of the event's own window, as the least-arbitrary tiebreaker.
  overlapping.sort((a, b) => {
    const aOverlap = Math.min(new Date(a.finishedAt || a.startedAt).getTime(), eventEndMs) - Math.max(new Date(a.startedAt).getTime(), eventStartMs);
    const bOverlap = Math.min(new Date(b.finishedAt || b.startedAt).getTime(), eventEndMs) - Math.max(new Date(b.startedAt).getTime(), eventStartMs);
    return bOverlap - aOverlap;
  });
  return overlapping[0].channelId;
}

function matchViaPlays(eventStartMs, eventEndMs) {
  const rows = plays
    .listPlays({ from: new Date(eventStartMs).toISOString(), to: new Date(eventEndMs).toISOString() })
    .filter((p) => p.platform === 'website');
  if (!rows.length) return null;

  const counts = new Map();
  rows.forEach((p) => counts.set(p.channelId, (counts.get(p.channelId) || 0) + 1));
  let bestChannelId = null;
  let bestCount = 0;
  counts.forEach((count, channelId) => {
    if (count > bestCount) {
      bestCount = count;
      bestChannelId = channelId;
    }
  });
  return bestChannelId;
}

// Returns a channelId, or null if nothing in either source overlaps this
// event's window - the caller should treat null as "ask the admin".
function matchChannelForEvent({ startedAt, finishedAt }) {
  const startMs = new Date(startedAt).getTime();
  const endMs = finishedAt ? new Date(finishedAt).getTime() : startMs;
  return matchViaRecordings(startMs, endMs) || matchViaPlays(startMs, endMs);
}

module.exports = { matchChannelForEvent };
