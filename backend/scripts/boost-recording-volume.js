// One-off maintenance tool to apply loudness normalization (see
// remuxWithLoudnessNormalization in ../src/recordings.js - same function
// the live pipeline now uses for every new recording) to recordings that
// were already uploaded before that change. Downloads from R2, normalizes,
// and either leaves the result here for you to preview or re-uploads it
// back to R2 at the same key. Run inside the backend container, which
// already has ffmpeg and the R2 credentials:
//
//   docker compose exec backend node scripts/boost-recording-volume.js [recordingId] [--upload]
//
// No recordingId: processes every recording in data/recordings.json, one
// at a time. <recordingId> (the id field in that file): processes just
// that one.
//
// Without --upload, this only ever writes local files (R2 isn't touched) -
// pull one down and check it sounds right before trusting the rest with
// --upload. Re-running reuses any already-downloaded/normalized files
// rather than redoing the work.

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { DATA_DIR } = require('../src/db');
const { remuxWithLoudnessNormalization } = require('../src/recordings');

const args = process.argv.slice(2);
const shouldUpload = args.includes('--upload');
const recordingIdArg = args.find((a) => a !== '--upload');

const RECORDINGS_FILE = path.join(DATA_DIR, 'recordings.json');
const WORKDIR = '/tmp/volume-boost';

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

async function processOne(r2, recording) {
  fs.mkdirSync(WORKDIR, { recursive: true });
  const originalPath = path.join(WORKDIR, `${recording.id}-original.mp4`);
  const boostedPath = path.join(WORKDIR, `${recording.id}-boosted.mp4`);

  if (!fs.existsSync(originalPath)) {
    console.log(`  Downloading ${recording.r2Key}...`);
    const obj = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: recording.r2Key }));
    await pipeline(obj.Body, fs.createWriteStream(originalPath));
  } else {
    console.log(`  Reusing already-downloaded original at ${originalPath}.`);
  }

  console.log('  Normalizing loudness (measuring, then encoding)...');
  await remuxWithLoudnessNormalization(originalPath, boostedPath);
  console.log(`  Boosted file written to ${boostedPath}`);

  if (!shouldUpload) {
    console.log('  Not uploaded - R2 untouched. Preview it, then re-run with --upload once you\'re happy.');
    return;
  }

  console.log(`  Uploading back to R2 at ${recording.r2Key} (overwriting the original)...`);
  const upload = new Upload({
    client: r2,
    partSize: 8 * 1024 * 1024,
    params: {
      Bucket: process.env.R2_BUCKET_NAME,
      Key: recording.r2Key,
      Body: fs.createReadStream(boostedPath),
      ContentType: 'video/mp4',
    },
  });
  await upload.done();

  const stat = fs.statSync(boostedPath);
  writeRecordings(readRecordings().map((r) => (r.id === recording.id ? { ...r, sizeBytes: stat.size } : r)));

  fs.rmSync(originalPath, { force: true });
  fs.rmSync(boostedPath, { force: true });
  console.log('  Done - the recording in the dashboard now points at the boosted file.');
}

(async () => {
  if (!process.env.R2_BUCKET_NAME) throw new Error('R2_BUCKET_NAME is not set');
  const r2 = getR2Client();

  const allRecordings = readRecordings();
  let targets = allRecordings;
  if (recordingIdArg) {
    const match = allRecordings.find((r) => r.id === recordingIdArg);
    if (!match) {
      console.error(`No recording found with id ${recordingIdArg} in ${RECORDINGS_FILE}`);
      process.exit(1);
    }
    targets = [match];
  }

  if (targets.length === 0) {
    console.log('No recordings to process.');
    return;
  }

  console.log(`Processing ${targets.length} recording(s)${shouldUpload ? ' (will upload each result)' : ' (preview only - nothing will be uploaded)'}...\n`);

  for (const recording of targets) {
    console.log(`[${recording.title || recording.channelName}] (${recording.id})`);
    try {
      // eslint-disable-next-line no-await-in-loop
      await processOne(r2, recording);
    } catch (err) {
      console.error(`  Failed: ${err.message}`);
    }
    console.log('');
  }

  console.log('All done.');
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
