// Renders the public /status page - live/recent uptime for the site's core
// components, sourced from history/summary.json in the Upptime repo
// (bobchomp/rtmpwebplayer-status), which runs its own checks every 5
// minutes on GitHub Actions, entirely independent of this app. Full
// incident history lives there too, as auto-opened/closed GitHub Issues.

const SUMMARY_URL = 'https://raw.githubusercontent.com/bobchomp/rtmpwebplayer-status/main/history/summary.json';
const ISSUES_URL = 'https://github.com/bobchomp/rtmpwebplayer-status/issues';

// Upptime's own checks already run every 5 minutes - re-fetching on every
// single pageview would just be extra load on GitHub's raw content CDN for
// data that's rarely fresher than a few minutes old anyway.
const CACHE_MS = 60 * 1000;

let cache = null; // { sites, fetchedAt }

async function getSites() {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.sites;
  try {
    const res = await fetch(SUMMARY_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const sites = await res.json();
    cache = { sites, fetchedAt: Date.now() };
    return sites;
  } catch (err) {
    // A transient GitHub hiccup shouldn't take the whole page down - stale
    // data (however old) beats an error page for a status page specifically.
    if (cache) return cache.sites;
    throw err;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function statusMeta(status) {
  if (status === 'up') return { label: 'Operational', className: 'status-up' };
  if (status === 'degraded') return { label: 'Degraded', className: 'status-degraded' };
  return { label: 'Down', className: 'status-down' };
}

function renderRows(sites) {
  return sites
    .map((site) => {
      const meta = statusMeta(site.status);
      return `
      <li class="status-row">
        <span class="status-row-name">${escapeHtml(site.name)}</span>
        <span class="status-pill ${meta.className}">${meta.label}</span>
        <span class="status-row-uptime">${escapeHtml(site.uptimeMonth || site.uptime)} uptime (30d)</span>
      </li>`;
    })
    .join('');
}

async function renderStatusPage() {
  let sites = null;
  let fetchFailed = false;
  try {
    sites = await getSites();
  } catch (err) {
    fetchFailed = true;
  }

  const allUp = sites && sites.every((s) => s.status === 'up');
  const anyDown = sites && sites.some((s) => s.status === 'down');

  const bannerClass = fetchFailed
    ? 'status-banner-unknown'
    : anyDown
    ? 'status-banner-down'
    : allUp
    ? 'status-banner-up'
    : 'status-banner-degraded';
  const bannerText = fetchFailed
    ? 'Status data is temporarily unavailable - check back shortly'
    : anyDown
    ? 'Some systems are experiencing issues'
    : allUp
    ? 'All systems operational'
    : 'Some systems are degraded';

  const rowsHtml = sites ? `<ul class="status-list">${renderRows(sites)}</ul>` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Status - RTMP Web Player</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Live status for stream.rossmackenzie.co.uk - streaming, playback, and the admin dashboard.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.png" type="image/png">
<link rel="stylesheet" href="/style.css">
<style>
  body { line-height: 1.6; }
  .status-wrap { max-width: 700px; margin: 0 auto; padding: 28px 20px 88px; }
  .status-nav { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 48px; }
  h1 { margin: 0 0 32px; }

  .status-banner {
    display: flex; align-items: center; gap: 10px; padding: 16px 18px; border-radius: var(--radius-md);
    font: 600 16px/1.3 var(--font-display); margin: 0 0 32px;
  }
  .status-banner-up { background: var(--grass-tint); color: #1D6B44; }
  .status-banner-degraded { background: var(--amber-tint); color: #6B4E14; }
  .status-banner-down { background: var(--ember-tint); color: #8A2E1C; }
  .status-banner-unknown { background: var(--surface-sunken); color: var(--slate); }
  .status-banner-dot { width: 10px; height: 10px; border-radius: 50%; background: currentColor; flex-shrink: 0; }

  .status-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .status-row {
    display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md);
    padding: 16px 18px; box-shadow: var(--shadow-card);
  }
  .status-row-name { font: 600 15px/1.3 var(--font-display); }
  .status-row-uptime { font-size: 13px; color: var(--slate); margin-left: auto; }
  .status-pill { font: 600 12px/1 var(--font-display); padding: 5px 10px; border-radius: 999px; white-space: nowrap; }
  .status-up { background: var(--grass-tint); color: #1D6B44; }
  .status-degraded { background: var(--amber-tint); color: #6B4E14; }
  .status-down { background: var(--ember-tint); color: #8A2E1C; }

  .status-footer-note { font-size: 13.5px; color: var(--slate); margin-top: 32px; }
  .status-footer-note a { color: var(--accent); }
</style>
</head>
<body>

<div class="status-wrap">

<nav class="status-nav">
  <span class="wordmark">
    <svg class="wordmark-icon" viewBox="0 0 32 32" aria-hidden="true">
      <path class="wm-arc wm-arc-1" d="M9 9 A16 16 0 0 1 25 25"/>
      <path class="wm-arc wm-arc-2" d="M9 14 A11 11 0 0 1 20 25"/>
      <path class="wm-arc wm-arc-3" d="M9 19 A6 6 0 0 1 15 25"/>
      <circle class="wm-dot" cx="9" cy="25" r="2.6"/>
    </svg>
    <span class="wordmark-text">RTMP <b>Web Player</b></span>
  </span>
  <a href="/" class="secondary">&larr; Back to site</a>
</nav>

<h1>Status</h1>

<div class="status-banner ${bannerClass}">
  <span class="status-banner-dot" aria-hidden="true"></span>
  <span>${escapeHtml(bannerText)}</span>
</div>

${rowsHtml}

<p class="status-footer-note">Checked automatically every 5 minutes. Past incidents are logged on <a href="${ISSUES_URL}">GitHub</a>.</p>

</div>

<footer class="site-footer">
  &copy; <span id="copyright-year"></span> Ross Mackenzie
  &middot; <a href="/privacy.html">Privacy policy</a>
</footer>

<script>document.getElementById('copyright-year').textContent = new Date().getFullYear();</script>
</body>
</html>`;
}

module.exports = { renderStatusPage };
