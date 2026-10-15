// Each address in ADMIN_EMAIL is its own fully separate account: it only
// ever sees channels it owns, plus the stats, recordings and Restream
// connection that belong to them. An account is identified by its
// lowercased email; that string is stored as `owner` on channels, plays and
// recordings.

const fs = require('fs');
const path = require('path');
const { readDb, writeDb, DATA_DIR } = require('./db');

function adminEmails() {
  return (process.env.ADMIN_EMAIL || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

// The first listed address owns everything created before accounts existed.
function primaryAccount() {
  return adminEmails()[0] || null;
}

function currentAccount(req) {
  return (req.session && req.session.account) || null;
}

function ownsChannel(channel, account) {
  return !!(channel && account && channel.owner === account);
}

function stampOwnerInFile(file, key, ownerFor) {
  if (!fs.existsSync(file)) return 0;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  let changed = 0;
  (data[key] || []).forEach((row) => {
    if (!row.owner) {
      row.owner = ownerFor(row);
      changed += 1;
    }
  });
  if (changed) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }
  return changed;
}

// Runs once at startup, before anything else reads the data. Idempotent:
// only rows without an owner are touched, so nothing already assigned moves.
// Plays and recordings take their channel's owner where the channel still
// exists, and the primary account otherwise, so history from deleted
// channels isn't orphaned.
function migrateOwnership() {
  const primary = primaryAccount();
  if (!primary) {
    console.warn('[accounts] ADMIN_EMAIL is empty - skipping ownership migration.');
    return;
  }

  const db = readDb();
  let channelCount = 0;
  Object.values(db.channels || {}).forEach((channel) => {
    if (!channel.owner) {
      channel.owner = primary;
      channelCount += 1;
    }
  });

  // The single pre-accounts Restream connection becomes the primary account's.
  let restreamMoved = false;
  db.restreamAccounts = db.restreamAccounts || {};
  if (db.restream) {
    if (!db.restreamAccounts[primary]) db.restreamAccounts[primary] = db.restream;
    delete db.restream;
    restreamMoved = true;
  }
  if (channelCount || restreamMoved) writeDb(db);

  const ownerFor = (row) => (db.channels[row.channelId] && db.channels[row.channelId].owner) || primary;
  const playCount = stampOwnerInFile(path.join(DATA_DIR, 'plays.json'), 'plays', ownerFor);
  const recordingCount = stampOwnerInFile(path.join(DATA_DIR, 'recordings.json'), 'recordings', ownerFor);

  if (channelCount || restreamMoved || playCount || recordingCount) {
    console.log(
      `[accounts] Assigned to ${primary}: ${channelCount} channel(s), ${playCount} stats row(s), ` +
      `${recordingCount} recording(s)${restreamMoved ? ', the Restream connection' : ''}.`
    );
  }
}

module.exports = { adminEmails, currentAccount, ownsChannel, migrateOwnership };
