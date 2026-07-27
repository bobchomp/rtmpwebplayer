const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const tar = require('tar');
const maxmind = require('maxmind');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'GeoLite2-City.mmdb');

// MaxMind re-builds GeoLite2 roughly weekly; re-downloading this often keeps
// city/region boundaries current without needing their separate geoipupdate
// tool inside the container.
const REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

let reader = null;
let readerMtime = 0;

function downloadDatabase() {
  const licenseKey = process.env.GEOIP_LICENSE_KEY;
  if (!licenseKey) return Promise.resolve(false);

  const url =
    'https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=' +
    encodeURIComponent(licenseKey) +
    '&suffix=tar.gz';

  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          res.resume();
          return https
            .get(res.headers.location, (res2) => handleDownloadResponse(res2, resolve, reject))
            .on('error', reject);
        }
        handleDownloadResponse(res, resolve, reject);
      })
      .on('error', reject);
  });
}

function handleDownloadResponse(res, resolve, reject) {
  if (res.statusCode !== 200) {
    res.resume();
    return reject(new Error('GeoLite2 download failed with status ' + res.statusCode));
  }

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmpDir = path.join(DATA_DIR, '.geoip-tmp');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  res
    .pipe(zlib.createGunzip())
    .pipe(
      tar.extract({
        cwd: tmpDir,
        strip: 1,
        filter: (entryPath) => entryPath.endsWith('.mmdb'),
      })
    )
    .on('finish', () => {
      const extracted = fs.readdirSync(tmpDir).find((f) => f.endsWith('.mmdb'));
      if (!extracted) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return reject(new Error('GeoLite2 archive did not contain an .mmdb file'));
      }
      fs.renameSync(path.join(tmpDir, extracted), DB_FILE);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve(true);
    })
    .on('error', reject);
}

// Called once at server startup. Never throws - a missing/failed database
// just means lookupIp() returns blanks, which is fine (the license key is
// optional, and stats rows are still useful without geo columns filled in).
async function ensureDatabase() {
  if (!process.env.GEOIP_LICENSE_KEY) return;

  const needsDownload = !fs.existsSync(DB_FILE);
  if (needsDownload) {
    try {
      await downloadDatabase();
      console.log('GeoLite2 database downloaded.');
    } catch (err) {
      console.error('Failed to download GeoLite2 database:', err.message);
    }
  }

  setInterval(() => {
    downloadDatabase().catch((err) => {
      console.error('Failed to refresh GeoLite2 database:', err.message);
    });
  }, REFRESH_MS).unref();
}

function getReader() {
  if (!fs.existsSync(DB_FILE)) return null;
  const mtime = fs.statSync(DB_FILE).mtimeMs;
  if (reader && mtime === readerMtime) return reader;
  reader = new maxmind.Reader(fs.readFileSync(DB_FILE));
  readerMtime = mtime;
  return reader;
}

// Returns { country, region, city } (each possibly null) for a given IP.
// Never throws - invalid/private/unresolvable IPs just come back blank.
function lookupIp(ip) {
  const blank = { country: null, region: null, city: null };
  if (!ip || !maxmind.validate(ip)) return blank;

  let db;
  try {
    db = getReader();
  } catch (err) {
    return blank;
  }
  if (!db) return blank;

  const record = db.get(ip);
  if (!record) return blank;

  return {
    country: (record.country && record.country.names && record.country.names.en) || null,
    region:
      (record.subdivisions &&
        record.subdivisions[0] &&
        record.subdivisions[0].names &&
        record.subdivisions[0].names.en) ||
      null,
    city: (record.city && record.city.names && record.city.names.en) || null,
  };
}

module.exports = { ensureDatabase, lookupIp };
