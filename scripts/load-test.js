#!/usr/bin/env node
// Kept identical to backend/src/downloads/load-test.js (the copy served by
// the dashboard's Stream Test download button) - update both together.
//
// Simulates N concurrent viewers hitting a real, running instance of this
// app (production or dev) to see how it holds up - meant to be run from
// your own computer, against the real public domain, not from the droplet
// itself.
//
// Each "virtual viewer" does exactly what a real embed player does:
//   - loads the embed page once
//   - polls /api/channels/:id/status every 5s (same interval as the real player)
//   - once live, fetches the HLS manifest + the latest segment on the same
//     cadence, and starts a heartbeat ping every 45s (same as real playback)
//
// It deliberately does NOT download full video segments - it reads just the
// first chunk of each one (enough to confirm it's served correctly and
// measure real response time) and aborts the rest. Downloading full segments
// for a few hundred viewers would mostly saturate *your own* internet
// connection long before it tells you anything about the server.
//
// Also downloadable on its own (no repo clone needed) from the dashboard's
// Stream Test page once logged in.
//
// Usage:
//   node scripts/load-test.js
// and answer the prompts (password, channel, viewers, duration, ramp) as
// they come up. The site is always https://stream.rossmackenzie.co.uk - no
// need to type it.
//
// Prefer flags instead (e.g. for scripting)? Any of these skip their prompt:
//   node scripts/load-test.js --yes --password <password> --channel <channel-id> --viewers 400 --duration 180 --ramp 30
// --yes skips the welcome banner/confirmation, the rest skip their own
// prompt as before (a wrong --password still exits immediately rather than
// falling back to asking). Add --url <base-url> to point it at somewhere
// other than production (e.g. dev).
//
// Find <channel-id> in the embed code on that channel's dashboard page -
// it's the UUID in the iframe's src, e.g. /embed/<channel-id>.
//
// Heads up: this channel needs to actually be live (a real test stream, or
// a looping video pushed in via ffmpeg) for the manifest/segment/heartbeat
// requests to have anything real to fetch - the status poll alone doesn't
// need that, but it's not testing much on its own.
//
// Also heads up: the heartbeat pings are indistinguishable from real
// viewers and WILL show up in the real Stats page for this channel (all
// from your one IP). Clean them up afterward from Stats > select by date >
// Delete selected, if you don't want test traffic mixed into real numbers.

const readline = require('node:readline/promises');

const DEFAULT_BASE_URL = 'https://stream.rossmackenzie.co.uk';

let BASE_URL, CHANNEL_ID, VIEWERS, DURATION_MS, RAMP_MS;

async function resolveConfig() {
  const args = parseArgs(process.argv.slice(2));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question, defaultValue) => {
    const answer = (await rl.question(`${question} [${defaultValue}]: `)).trim();
    return answer || String(defaultValue);
  };

  const PASSWORD = 'smithton';
  if (args.password !== undefined) {
    if (args.password !== PASSWORD) {
      console.error('Incorrect password.');
      rl.close();
      process.exit(1);
    }
  } else {
    let attempt = '';
    while (attempt !== PASSWORD) {
      if (attempt) console.log('Incorrect password.\n');
      attempt = (await rl.question('Password: ')).trim();
    }
  }

  BASE_URL = args.url || DEFAULT_BASE_URL;

  if (!args.yes) {
    const exampleChannelId = process.stdout.isTTY
      ? '\x1b[33m468127c7-2fa6-44ef-b93a-d7d3b3aea613\x1b[0m'
      : '468127c7-2fa6-44ef-b93a-d7d3b3aea613';
    console.log(`************************************************************************
WELCOME TO STREAM.ROSSMACKENZIE.CO.UK STREAM TEST

This generates real traffic against the live site - hundreds of
simulated viewers, indistinguishable from real ones. Only run it against
a channel you're deliberately testing, and expect it to show up in that
channel's Stats afterward.

Please have the following details ready before you continue:

1. The Channel ID  - the string in the link when on the channel page. For example: https://stream.rossmackenzie.co.uk/dashboard#/channel/${exampleChannelId}
2. Numbers of Viewers to simulate - how many people you want to simulate joining in on the stream
3. Duration - I recommend you set this to 180, only set it to something else if you know what you're doing!
4. Ramp Up - I recommend you set this to 30, again, only set it to something else if you know what you're doing!


PLEASE ENSURE THERE ARE NO PRODUCTION STREAMS ACTIVE NOW!
************************************************************************`);
    const proceed = (await rl.question('\nWould you like to continue? [y/N] ')).trim();
    if (!/^y(es)?$/i.test(proceed)) {
      console.log('Aborted.');
      rl.close();
      process.exit(1);
    }
    console.log('');
  }

  CHANNEL_ID = args.channel;
  while (!CHANNEL_ID) {
    CHANNEL_ID = (await rl.question('Channel ID: ')).trim();
  }

  VIEWERS = Number(args.viewers ?? await ask('Viewers to simulate', 400));
  DURATION_MS = Number(args.duration ?? await ask('Duration (seconds)', 180)) * 1000;
  RAMP_MS = Number(args.ramp ?? await ask('Ramp-up (seconds)', 30)) * 1000;

  rl.close();
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

// ===================== Stats collection =====================

const stats = {}; // label -> { count, errors, statusCounts: {}, latencies: [] }

function recordStat(label, status, ms) {
  if (!stats[label]) stats[label] = { count: 0, errors: 0, statusCounts: {}, latencies: [] };
  const s = stats[label];
  s.count++;
  s.latencies.push(ms);
  if (status === 0 || status >= 400) s.errors++;
  s.statusCounts[status] = (s.statusCounts[status] || 0) + 1;
}

async function timedFetch(label, url, opts) {
  const start = performance.now();
  try {
    const res = await fetch(url, opts);
    recordStat(label, res.status, performance.now() - start);
    return res;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    recordStat(label, 0, performance.now() - start);
    return null;
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function printSummary() {
  console.log('\n=== Results ===');
  const rows = Object.keys(stats).sort();
  for (const label of rows) {
    const s = stats[label];
    const sorted = [...s.latencies].sort((a, b) => a - b);
    const avg = sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1);
    const errRate = ((s.errors / s.count) * 100).toFixed(1);
    console.log(
      `${label.padEnd(10)} requests=${String(s.count).padEnd(7)} errors=${String(s.errors).padEnd(5)} (${errRate}%)  ` +
      `avg=${avg.toFixed(0)}ms  p50=${percentile(sorted, 50).toFixed(0)}ms  p95=${percentile(sorted, 95).toFixed(0)}ms  max=${(sorted[sorted.length - 1] || 0).toFixed(0)}ms`
    );
    const statusStr = Object.entries(s.statusCounts)
      .map(([code, n]) => `${code === '0' ? 'network-error' : code}:${n}`)
      .join(', ');
    console.log(`  status codes: ${statusStr}`);
  }
  console.log('');
}

// ===================== Virtual viewer =====================

async function readFirstChunkThenAbort(res) {
  if (!res || !res.body) return;
  const reader = res.body.getReader();
  try {
    await reader.read();
  } catch (e) {
    // ignore - we're intentionally not reading the whole thing
  }
  try {
    await reader.cancel();
  } catch (e) {
    // ignore
  }
}

async function fetchManifestAndSegment(signal) {
  const manifestUrl = `${BASE_URL}/live/${CHANNEL_ID}/index.m3u8?_=${Date.now()}`;
  const res = await timedFetch('manifest', manifestUrl, { signal });
  if (!res || !res.ok) return;
  const text = await res.text();
  const segmentLines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const lastSegment = segmentLines[segmentLines.length - 1];
  if (!lastSegment) return;
  const segmentUrl = `${BASE_URL}/live/${CHANNEL_ID}/${lastSegment}`;
  const segRes = await timedFetch('segment', segmentUrl, { signal });
  await readFirstChunkThenAbort(segRes);
}

async function sendHeartbeat(signal) {
  await timedFetch('heartbeat', `${BASE_URL}/api/stats/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId: CHANNEL_ID }),
    signal,
  });
}

async function sleep(ms, signal) {
  await new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

async function runViewer(endAt, signal) {
  try {
    await timedFetch('embed', `${BASE_URL}/embed/${CHANNEL_ID}`, { signal });

    let playing = false;
    let heartbeatTimer = null;

    while (Date.now() < endAt) {
      const statusRes = await timedFetch('status', `${BASE_URL}/api/channels/${CHANNEL_ID}/status`, { signal });
      const data = statusRes && statusRes.ok ? await statusRes.json().catch(() => null) : null;

      if (data && data.isLive) {
        if (!playing) {
          playing = true;
          sendHeartbeat(signal).catch(() => {});
          heartbeatTimer = setInterval(() => sendHeartbeat(signal).catch(() => {}), 45000);
        }
        await fetchManifestAndSegment(signal).catch(() => {});
      }

      await sleep(5000, signal);
    }

    if (heartbeatTimer) clearInterval(heartbeatTimer);
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  }
}

// ===================== Orchestration =====================

async function main() {
  console.log(`Load test: ${VIEWERS} viewers against ${BASE_URL} (channel ${CHANNEL_ID})`);
  console.log(`Ramp-up: ${RAMP_MS / 1000}s, then holding for ${DURATION_MS / 1000}s\n`);

  const controller = new AbortController();
  process.on('SIGINT', () => {
    console.log('\nStopping early (Ctrl+C)...');
    controller.abort();
  });

  const launchDelayMs = VIEWERS > 1 ? RAMP_MS / VIEWERS : 0;
  const testEndAt = Date.now() + RAMP_MS + DURATION_MS;

  const viewerPromises = [];
  for (let i = 0; i < VIEWERS; i++) {
    if (controller.signal.aborted) break;
    viewerPromises.push(runViewer(testEndAt, controller.signal));
    if (launchDelayMs > 0) await sleep(launchDelayMs, controller.signal).catch(() => {});
  }

  const progressTimer = setInterval(() => {
    const totalRequests = Object.values(stats).reduce((sum, s) => sum + s.count, 0);
    const totalErrors = Object.values(stats).reduce((sum, s) => sum + s.errors, 0);
    console.log(`  ...${totalRequests} requests so far, ${totalErrors} errors`);
  }, 10000);
  progressTimer.unref();

  await Promise.all(viewerPromises);
  clearInterval(progressTimer);
  printSummary();
}

resolveConfig()
  .then(main)
  .catch((err) => {
    console.error('Load test failed:', err);
    process.exit(1);
  });
