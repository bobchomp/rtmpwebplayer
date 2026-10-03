// Shared "which service is this?" classification - a single source of truth
// for both plays.js (merges repeat visits from the same IP into one row per
// service, rather than per 30-minute gap) and statsTemplateExport.js (buckets
// those rows into one column per service). Keeping this in one place means a
// viewer counted as one view at record time always lands in exactly one
// bucket on export, instead of the two classifications ever drifting apart.
//
// The server's own OS clock is very likely UTC, not the church's local time -
// computing "before/after 1pm" in raw UTC would misclassify services during
// British Summer Time (UTC+1, roughly late March to late October). Intl's
// timeZone support is built into Node (no dependency needed) and handles the
// DST transition correctly.
const LONDON_TZ = 'Europe/London';
const AM_PM_CUTOFF_HOUR = 13; // 1pm

const hourFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: LONDON_TZ, hour: 'numeric', hourCycle: 'h23' });
const dateKeyFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: LONDON_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const labelFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: LONDON_TZ, day: '2-digit', month: 'short' });

function londonHour(date) {
  return Number(hourFormatter.format(date));
}

// 'YYYY-MM-DD' in London local time, used purely as a stable sort/group key
// (not displayed) - en-CA formats as YYYY-MM-DD directly.
function londonDateKey(date) {
  return dateKeyFormatter.format(date);
}

// e.g. "04jan" - matches the manually-compiled sheet this export is shaped
// after (zero-padded day, lowercase three-letter month, no separator).
function londonDateLabel(date) {
  const parts = labelFormatter.formatToParts(date);
  const day = parts.find((p) => p.type === 'day').value;
  const month = parts.find((p) => p.type === 'month').value.toLowerCase();
  return `${day}${month}`;
}

function half(date) {
  return londonHour(date) < AM_PM_CUTOFF_HOUR ? 'AM' : 'PM';
}

// A stable per-service id, e.g. "2026-09-27-AM" - two timestamps share one
// only if they fall on the same London calendar date and the same side of
// the 1pm cutoff.
function serviceKey(date) {
  return `${londonDateKey(date)}-${half(date)}`;
}

module.exports = { LONDON_TZ, AM_PM_CUTOFF_HOUR, londonHour, londonDateKey, londonDateLabel, half, serviceKey };
