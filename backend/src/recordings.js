const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { DATA_DIR, readDb } = require('./db');

const execFileAsync = promisify(execFile);

const RECORDINGS_FILE = path.join(DATA_DIR, 'recordings.json');

// 0 (or unset) means keep every recording until manually deleted from the
// dashboard - nothing auto-expires.
const RETENTION_DAYS = Number(process.env.RECORDING_RETENTION_DAYS) || 0;
const RETENTION_SWEEP_MS = 24 * 60 * 60 * 1000;

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(RECORDINGS_FILE)) {
    fs.writeFileSync(RECORDINGS_FILE, JSON.stringify({ recordings: [] }, null, 2));
  }
}

function readAll() {
  ensureFile();
  return JSON.parse(fs.readFileSync(RECORDINGS_FILE, 'utf8')).recordings || [];
}

function writeAll(rows) {
  ensureFile();
  const tmpFile = `${RECORDINGS_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify({ recordings: rows }, null, 2));
  fs.renameSync(tmpFile, RECORDINGS_FILE);
}

// Recordings are opt-in per channel and R2 is optional overall (same
// pattern as GEOIP_LICENSE_KEY) - null here just means "not configured yet",
// handled gracefully everywhere it's used rather than throwing.
function getR2Client() {
  if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    return null;
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

// Passing no channelId returns recordings for every channel, newest first -
// used by the dashboard's "All channels" recordings view.
function listRecordings(channelId) {
  return readAll()
    .filter((r) => !channelId || r.channelId === channelId)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
}

async function ffprobeDuration(filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    const seconds = parseFloat(stdout);
    return Number.isFinite(seconds) ? Math.round(seconds) : null;
  } catch (err) {
    return null;
  }
}

async function cleanupLocalFiles(...filePaths) {
  await Promise.all(filePaths.map((p) => fs.promises.rm(p, { force: true }).catch(() => {})));
}

// Called once a recording's raw .ts file is fully written (see
// routes/rtmpHooks.js's POST /recording-done, itself called by
// record-stop.sh once ffmpeg has actually exited, not just been asked to).
// Remuxes to a proper, seekable .mp4 (stream copy - no re-encoding, so this
// is fast and cheap on CPU), uploads it to R2, records the metadata, then
// deletes both local files - nothing stays on the droplet's own disk once
// this finishes successfully.
async function processFinishedRecording({ channel, rawFilePath }) {
  const r2 = getR2Client();
  if (!r2 || !process.env.R2_BUCKET_NAME) {
    console.error(
      `Recording finished for channel ${channel.id} but R2 isn't configured ` +
      '(R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET_NAME) - leaving the raw file in place.'
    );
    return;
  }
  if (!fs.existsSync(rawFilePath)) {
    console.error(`Recording file not found: ${rawFilePath}`);
    return;
  }

  const startedAtMatch = path.basename(rawFilePath).match(/^(\d+)\.ts$/);
  const startedAt = startedAtMatch
    ? new Date(Number(startedAtMatch[1]) * 1000).toISOString()
    : new Date().toISOString();

  const mp4Path = rawFilePath.replace(/\.ts$/, '.mp4');

  try {
    await execFileAsync('ffmpeg', ['-y', '-i', rawFilePath, '-c', 'copy', '-movflags', '+faststart', mp4Path]);

    const stat = fs.statSync(mp4Path);
    const durationSeconds = await ffprobeDuration(mp4Path);

    const id = crypto.randomUUID();
    const r2Key = `${channel.id}/${id}.mp4`;

    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: r2Key,
      Body: fs.createReadStream(mp4Path),
      ContentType: 'video/mp4',
      ContentLength: stat.size,
    }));

    const rows = readAll();
    rows.push({
      id,
      channelId: channel.id,
      channelName: channel.name,
      title: channel.title || channel.name,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationSeconds,
      sizeBytes: stat.size,
      r2Key,
    });
    writeAll(rows);
    // Only delete the local copies once everything above has actually
    // succeeded - deleting them unconditionally (e.g. in a `finally`) would
    // silently destroy the only copy of the recording if the upload failed
    // for any reason (bad credentials, wrong bucket, network blip).
    await cleanupLocalFiles(rawFilePath, mp4Path);
  } catch (err) {
    console.error(
      `Failed to process recording for channel ${channel.id} - raw file kept for retry: ${rawFilePath}`,
      err.message
    );
  }
}

// Short-lived (10 min) signed URL - the browser fetches the video straight
// from R2, so it's R2's bandwidth being used for playback/download, not the
// droplet's. Passing download:true adds a Content-Disposition header to
// R2's response (via ResponseContentDisposition - S3-compatible APIs honor
// this on the object response itself, not just the URL), which is what
// actually makes the browser save the file instead of just playing it
// inline - a plain `download` attribute on a link doesn't force that for a
// cross-origin URL like this one.
async function getPlaybackUrl(recordingId, { download } = {}) {
  const recording = readAll().find((r) => r.id === recordingId);
  if (!recording) return null;
  const r2 = getR2Client();
  if (!r2) return null;

  const commandInput = { Bucket: process.env.R2_BUCKET_NAME, Key: recording.r2Key };
  if (download) {
    const safeTitle = (recording.title || 'recording').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
    const dateStamp = recording.startedAt.slice(0, 10);
    commandInput.ResponseContentDisposition = `attachment; filename="${safeTitle}-${dateStamp}.mp4"`;
  }

  const command = new GetObjectCommand(commandInput);
  return getSignedUrl(r2, command, { expiresIn: 600 });
}

async function deleteRecording(recordingId) {
  const recording = readAll().find((r) => r.id === recordingId);
  if (!recording) return false;

  const r2 = getR2Client();
  if (r2) {
    try {
      await r2.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: recording.r2Key }));
    } catch (err) {
      console.error(`Failed to delete recording ${recordingId} from R2:`, err.message);
    }
  }

  // Re-read rather than reusing the array captured before the R2 await -
  // otherwise a recording written by a concurrent call while that await was
  // in flight would get silently dropped by writing back the stale array.
  writeAll(readAll().filter((r) => r.id !== recordingId));
  return true;
}

async function sweepExpiredRecordings() {
  if (!RETENTION_DAYS) return;
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const expired = readAll().filter((r) => new Date(r.startedAt).getTime() < cutoff);
  for (const recording of expired) {
    // eslint-disable-next-line no-await-in-loop
    await deleteRecording(recording.id);
  }
}

sweepExpiredRecordings().catch((err) => console.error('Recording retention sweep failed:', err.message));
setInterval(() => {
  sweepExpiredRecordings().catch((err) => console.error('Recording retention sweep failed:', err.message));
}, RETENTION_SWEEP_MS).unref();

// A raw recording's .ts file always survives whatever interrupts its
// finalize-and-upload handoff - a killed rtmp container, a hung ffmpeg that
// needed a manual kill, a dropped recording-done webhook - since it lives
// on its own durable volume, untouched by any of that. The only thing that
// can actually go missing is the notification that it's ready. This scans
// for raw files nobody's actively writing to anymore and finishes
// processing them automatically, so an interruption self-heals on its own
// instead of needing someone to notice a gap in the Recordings tab and
// manually reprocess it (see rtmpHooks.js's /recording-done for the normal,
// non-orphaned path this mirrors).
const RAW_DIR = '/recordings/raw';
// Long enough that a file still being actively appended to every few
// seconds by a live recording is never mistaken for an abandoned one -
// short enough that a genuinely finished/stuck one doesn't sit around
// unprocessed for long. Anything currently mid-recording will simply be
// skipped this pass and picked up on a later one once it's actually done.
const RECONCILE_STALE_MS = 5 * 60 * 1000;
const RECONCILE_INTERVAL_MS = 30 * 60 * 1000;

async function reconcileOrphanedRecordings() {
  let streamKeys;
  try {
    streamKeys = await fs.promises.readdir(RAW_DIR);
  } catch (err) {
    return; // nothing's ever been recorded yet - RAW_DIR may not even exist
  }

  const db = readDb();

  for (const streamKey of streamKeys) {
    const dir = path.join(RAW_DIR, streamKey);
    let files;
    try {
      // eslint-disable-next-line no-await-in-loop
      files = await fs.promises.readdir(dir);
    } catch (err) {
      continue; // not actually a directory, or vanished - skip it
    }

    const channel = Object.values(db.channels || {}).find((c) => c.streamKey === streamKey);

    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      const rawFilePath = path.join(dir, file);

      let stat;
      try {
        // eslint-disable-next-line no-await-in-loop
        stat = await fs.promises.stat(rawFilePath);
      } catch (err) {
        continue; // disappeared between readdir and stat - already handled
      }

      if (Date.now() - stat.mtimeMs < RECONCILE_STALE_MS) continue;

      if (!channel) {
        // No channel to attribute this to (e.g. deleted since) - same
        // cleanup rtmpHooks.js's /recording-done does for this case.
        // eslint-disable-next-line no-await-in-loop
        await fs.promises.rm(rawFilePath, { force: true }).catch(() => {});
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      await processFinishedRecording({ channel, rawFilePath });
    }
  }
}

reconcileOrphanedRecordings().catch((err) => console.error('Recording reconciliation sweep failed:', err.message));
setInterval(() => {
  reconcileOrphanedRecordings().catch((err) => console.error('Recording reconciliation sweep failed:', err.message));
}, RECONCILE_INTERVAL_MS).unref();

module.exports = {
  listRecordings,
  processFinishedRecording,
  getPlaybackUrl,
  deleteRecording,
  sweepExpiredRecordings,
  reconcileOrphanedRecordings,
};
