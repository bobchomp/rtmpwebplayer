// One-off maintenance tool for a recording uploaded before the A/V sync fix
// in rtmp/record-start.sh (see git history) - downloads it from R2, delays
// the video stream by a given offset so it lines up with the audio, and
// either leaves the result here for you to preview or re-uploads it back to
// R2 at the same key. Run inside the backend container, which already has
// ffmpeg and the R2 credentials:
//
//   docker compose exec backend node scripts/fix-recording-sync.js <recordingId> <offsetSeconds> [--upload]
//
// <recordingId> is the id field in data/recordings.json (or ask the app for
// it - there's no dashboard UI for this, it's an emergency-only tool).
// <offsetSeconds> is how far AHEAD video is of audio, in seconds (positive).
//
// Without --upload, this only ever writes a local file (data isn't touched
// in R2) - pull that down and check it looks right before committing to it
// with --upload. Re-running with a different offset re-uses the already
// downloaded original rather than fetching it again.

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { execFileSync } = require('child_process');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { DATA_DIR } = require('../src/db');

const [, , recordingId, offsetArg, uploadFlag] = process.argv;

if (!recordingId || !offsetArg) {
  console.error('Usage: node fix-recording-sync.js <recordingId> <offsetSeconds> [--upload]');
  console.error('  offsetSeconds: how far AHEAD video is of audio, in seconds (positive number)');
  process.exit(1);
}

const offsetSeconds = Number(offsetArg);
if (!Number.isFinite(offsetSeconds) || offsetSeconds <= 0) {
  console.error('offsetSeconds must be a positive number');
  process.exit(1);
}
const shouldUpload = uploadFlag === '--upload';

const RECORDINGS_FILE = path.join(DATA_DIR, 'recordings.json');
const WORKDIR = '/tmp/sync-fix';

function readRecordings() {
  return JSON.parse(fs.readFileSync(RECORDINGS_FILE, 'utf8')).recordings || [];
}

function writeRecordings(rows) {
  fs.writeFileSync(RECORDINGS_FILE, JSON.stringify({ recordings: rows }, null, 2));
}

function getR2Client() {
  if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    throw new Error("R2 isn't configured (R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY)");
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

(async () => {
  const rows = readRecordings();
  const recording = rows.find((r) => r.id === recordingId);
  if (!recording) {
    console.error(`No recording found with id ${recordingId} in ${RECORDINGS_FILE}`);
    process.exit(1);
  }

  fs.mkdirSync(WORKDIR, { recursive: true });
  const originalPath = path.join(WORKDIR, `${recordingId}-original.mp4`);
  const fixedPath = path.join(WORKDIR, `${recordingId}-fixed.mp4`);

  const r2 = getR2Client();
  if (!process.env.R2_BUCKET_NAME) throw new Error('R2_BUCKET_NAME is not set');

  if (!fs.existsSync(originalPath)) {
    console.log(`Downloading ${recording.r2Key} from R2 (cached at ${originalPath} after this)...`);
    const obj = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: recording.r2Key }));
    await pipeline(obj.Body, fs.createWriteStream(originalPath));
    console.log('Download complete.');
  } else {
    console.log(`Reusing already-downloaded original at ${originalPath} (delete it to force a fresh download).`);
  }

  console.log(`Delaying the video stream by ${offsetSeconds}s to line it up with audio...`);
  execFileSync('ffmpeg', [
    '-y',
    '-i', originalPath,
    '-itsoffset', String(offsetSeconds),
    '-i', originalPath,
    '-map', '1:v', '-map', '0:a',
    '-c', 'copy',
    '-movflags', '+faststart',
    fixedPath,
  ], { stdio: 'inherit' });
  console.log(`Corrected file written to ${fixedPath}`);

  if (!shouldUpload) {
    console.log('\nNot uploaded - this only touched the local file, R2 is untouched. Suggested next steps:');
    console.log(`  1. Pull it down and check it: scp <this-droplet>:${fixedPath} .`);
    console.log('  2. Looks right?  Re-run this exact command with --upload appended to replace the R2 copy.');
    console.log('  3. Still off?  Re-run with a different offsetSeconds (the downloaded original is cached, so this is fast).');
    return;
  }

  console.log(`Uploading corrected file back to R2 at ${recording.r2Key} (overwriting the original)...`);
  const upload = new Upload({
    client: r2,
    partSize: 8 * 1024 * 1024,
    params: {
      Bucket: process.env.R2_BUCKET_NAME,
      Key: recording.r2Key,
      Body: fs.createReadStream(fixedPath),
      ContentType: 'video/mp4',
    },
  });
  await upload.done();

  const stat = fs.statSync(fixedPath);
  writeRecordings(readRecordings().map((r) => (r.id === recordingId ? { ...r, sizeBytes: stat.size } : r)));

  fs.rmSync(originalPath, { force: true });
  fs.rmSync(fixedPath, { force: true });

  console.log('Done - the recording in the dashboard now points at the corrected file.');
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
