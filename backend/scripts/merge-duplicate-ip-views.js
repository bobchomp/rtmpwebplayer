// One-off cleanup for website-view rows recorded before the "one view per
// IP per service" fix in plays.js (see git history) - before that fix, a
// visitor who reconnected more than 30 minutes into the same service got a
// second row instead of being merged into their first one, inflating both
// the Stats page's row count and Export in Template's per-service totals.
// This merges any such pre-existing duplicates in data/plays.json the same
// way the live app now does it going forward: one row per
// (channel, IP, service), keeping the earliest firstPlayAt, the latest
// latestPlayAt, and the first ping's device/geo info.
//
// Dry-run by default - just reports what it would do. Re-run with --apply
// to actually write the change (a timestamped .bak copy of plays.json is
// made first).
//
// IMPORTANT: the running backend keeps its own in-memory copy of
// plays.json and flushes it back to disk every few seconds (see
// FLUSH_INTERVAL_MS in plays.js) - if you run this with --apply while the
// backend is still running, that flush can silently overwrite this script's
// change moments later. Stop the backend first:
//
//   docker compose exec backend node scripts/merge-duplicate-ip-views.js            # dry run
//   docker compose stop backend
//   docker compose exec backend node scripts/merge-duplicate-ip-views.js --apply
//   docker compose start backend
//
// (swap in dev-backend for the dev site's data instead.)

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../src/db');
const { serviceKey } = require('../src/serviceWindow');

const PLAYS_FILE = path.join(DATA_DIR, 'plays.json');
const APPLY = process.argv.includes('--apply');

const data = JSON.parse(fs.readFileSync(PLAYS_FILE, 'utf8'));
const rows = data.plays || [];

// Same grouping key as the live fix: channel + IP + which service
// (channel/IP matches recordPlay's merge condition; website-only, since
// Restream-imported rows are already deduplicated by their own deterministic
// id - see upsertImportedPlays in plays.js).
const groups = new Map(); // key -> [{ row, index }]
rows.forEach((row, index) => {
  const platform = row.platform || 'website';
  if (platform !== 'website' || !row.channelId || !row.ip || !row.firstPlayAt) return;
  const date = new Date(row.firstPlayAt);
  if (Number.isNaN(date.getTime())) return;
  const key = `${row.channelId}|${row.ip}|${serviceKey(date)}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push({ row, index });
});

const indicesToRemove = new Set();
let rowsRemoved = 0;

groups.forEach((entries, key) => {
  if (entries.length < 2) return;

  entries.sort((a, b) => new Date(a.row.firstPlayAt) - new Date(b.row.firstPlayAt));
  const keeper = entries[0].row;
  const latestMs = entries.reduce((max, e) => {
    const t = new Date(e.row.latestPlayAt || e.row.firstPlayAt).getTime();
    return Number.isNaN(t) ? max : Math.max(max, t);
  }, new Date(keeper.latestPlayAt || keeper.firstPlayAt).getTime());
  keeper.latestPlayAt = new Date(latestMs).toISOString();

  console.log(`  ${key}: merging ${entries.length} rows -> 1 (kept ${keeper.id}, firstPlayAt ${keeper.firstPlayAt}, latestPlayAt now ${keeper.latestPlayAt})`);
  entries.slice(1).forEach((e) => {
    indicesToRemove.add(e.index);
    rowsRemoved += 1;
  });
});

console.log(`\nFound ${[...groups.values()].filter((e) => e.length > 1).length} service(s) with duplicate same-IP rows - ${rowsRemoved} duplicate row(s) would be removed, leaving ${rows.length - rowsRemoved} of ${rows.length} total rows.`);

if (rowsRemoved === 0) {
  console.log('Nothing to merge.');
  process.exit(0);
}

if (!APPLY) {
  console.log('Dry run only - nothing written. Re-run with --apply to write the change (stop the backend first - see the note at the top of this script).');
  process.exit(0);
}

const outRows = rows.filter((_, i) => !indicesToRemove.has(i));

const backupFile = `${PLAYS_FILE}.bak-${Date.now()}`;
fs.copyFileSync(PLAYS_FILE, backupFile);
console.log(`Backed up original to ${backupFile}`);

fs.writeFileSync(PLAYS_FILE, JSON.stringify({ plays: outRows }, null, 2));
console.log(`Wrote ${outRows.length} rows to ${PLAYS_FILE}.`);
