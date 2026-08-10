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

// DigitalOcean and Cloudflare (hosting + CDN) are both built on Atlassian
// Statuspage.io, same as this project's own status page - which publishes a
// free, public, unauthenticated summary at this exact path on every
// Statuspage-powered domain. Deliberately NOT run through Upptime: its
// checks are just an HTTP status code, and this endpoint always returns 200
// even mid-outage (that's the point of it) - the real signal is the
// `status.indicator` field in the body, which only this app's own fetch can
// actually read. summary.json (rather than the smaller status.json) also
// includes any active incidents in the same call, so a click can show them
// in a popup here instead of sending the visitor away to check.
const DEPENDENCIES = [
  { key: 'digitalocean', name: 'DigitalOcean', statusUrl: 'https://status.digitalocean.com/api/v2/summary.json', pageUrl: 'https://status.digitalocean.com' },
  { key: 'cloudflare', name: 'Cloudflare', statusUrl: 'https://www.cloudflarestatus.com/api/v2/summary.json', pageUrl: 'https://www.cloudflarestatus.com' },
];

let depCache = null; // { results, fetchedAt }

async function fetchDependency(dep) {
  try {
    const res = await fetch(dep.statusUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return {
      key: dep.key,
      name: dep.name,
      pageUrl: dep.pageUrl,
      indicator: data.status.indicator,
      description: data.status.description,
      incidents: Array.isArray(data.incidents) ? data.incidents : [],
    };
  } catch (err) {
    // Same "show unknown, don't break the page" approach as the main
    // component list - a third-party API hiccup shouldn't take /status down.
    return { key: dep.key, name: dep.name, pageUrl: dep.pageUrl, indicator: null, description: null, incidents: [] };
  }
}

async function getDependencies() {
  if (depCache && Date.now() - depCache.fetchedAt < CACHE_MS) return depCache.results;
  const results = await Promise.all(DEPENDENCIES.map(fetchDependency));
  depCache = { results, fetchedAt: Date.now() };
  return results;
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

function indicatorMeta(indicator) {
  if (indicator === 'none') return { label: 'Operational', className: 'status-up' };
  if (indicator === 'minor') return { label: 'Minor issues', className: 'status-degraded' };
  if (indicator === 'major' || indicator === 'critical') return { label: 'Major issues', className: 'status-down' };
  return { label: 'Unknown', className: 'status-unknown' };
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  } catch (err) {
    return iso;
  }
}

function renderIncident(incident) {
  const latestUpdate = incident.incident_updates && incident.incident_updates[0];
  return `
    <div class="status-incident">
      <div class="status-incident-head">
        <span class="status-incident-name">${escapeHtml(incident.name)}</span>
        <span class="status-incident-status">${escapeHtml(incident.status)}</span>
      </div>
      ${latestUpdate ? `<p class="status-incident-body">${escapeHtml(latestUpdate.body)}</p>` : ''}
      <p class="status-incident-time">Updated ${escapeHtml(formatDate(incident.updated_at))}</p>
    </div>`;
}

function renderDependencyModalBody(dep) {
  if (!dep.incidents.length) return '<p class="status-modal-empty">No active incidents.</p>';
  return dep.incidents.map(renderIncident).join('');
}

function renderDependencyRows(deps) {
  return deps
    .map((dep) => {
      const meta = indicatorMeta(dep.indicator);
      return `
      <li class="status-row">
        <button type="button" class="status-row-name status-dep-btn" data-dep="${escapeHtml(dep.key)}">${escapeHtml(dep.name)}</button>
        <span class="status-pill ${meta.className}">${escapeHtml(meta.label)}</span>
      </li>`;
    })
    .join('');
}

// Embedded as JSON for the click-to-open-popup script below, rather than a
// separate API route - the data's already been fetched server-side for the
// row pills, so there's nothing more to ask the server for on click.
function buildDependencyDataJson(deps) {
  const data = {};
  deps.forEach((dep) => {
    data[dep.key] = { name: dep.name, pageUrl: dep.pageUrl, bodyHtml: renderDependencyModalBody(dep) };
  });
  // A `</script` inside incident text (from either provider) would otherwise
  // terminate this script block early when the browser parses the HTML.
  return JSON.stringify(data).replace(/<\/script/gi, '<\\/script');
}

async function renderStatusPage() {
  let sites = null;
  let fetchFailed = false;
  const [sitesResult, dependencies] = await Promise.all([
    getSites()
      .then((s) => ({ ok: true, sites: s }))
      .catch(() => ({ ok: false })),
    getDependencies(),
  ]);
  if (sitesResult.ok) {
    sites = sitesResult.sites;
  } else {
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
  const dependenciesHtml = `
<h2>Dependencies</h2>
<p class="status-section-note">Third-party infrastructure this site relies on - reported directly by their own status pages, not tracked in this project's own uptime history. Click one for its current incidents.</p>
<ul class="status-list">${renderDependencyRows(dependencies)}</ul>`;
  const dependencyDataJson = buildDependencyDataJson(dependencies);

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
  .status-row-name a { color: inherit; text-decoration: none; }
  .status-row-name a:hover { text-decoration: underline; }
  .status-dep-btn { background: none; border: none; padding: 0; margin: 0; cursor: pointer; font: inherit; color: inherit; text-align: left; }
  .status-dep-btn:hover { text-decoration: underline; }
  .status-row-uptime { font-size: 13px; color: var(--slate); margin-left: auto; }
  .status-pill { font: 600 12px/1 var(--font-display); padding: 5px 10px; border-radius: 999px; white-space: nowrap; }
  .status-up { background: var(--grass-tint); color: #1D6B44; }
  .status-degraded { background: var(--amber-tint); color: #6B4E14; }
  .status-down { background: var(--ember-tint); color: #8A2E1C; }
  .status-unknown { background: var(--surface-sunken); color: var(--slate); }

  h2 { font: 600 18px/1.3 var(--font-display); margin: 40px 0 6px; }
  .status-section-note { font-size: 13.5px; color: var(--slate); margin: 0 0 16px; }

  .status-footer-note { font-size: 13.5px; color: var(--slate); margin-top: 32px; }
  .status-footer-note a { color: var(--accent); }

  .status-modal-backdrop { position: fixed; inset: 0; background: rgba(34,38,43,.45); padding: 20px; z-index: 1000; }
  .status-modal-backdrop:not([hidden]) { display: flex; align-items: center; justify-content: center; }
  .status-modal {
    background: var(--surface); border-radius: var(--radius-lg); box-shadow: var(--shadow-card);
    max-width: 480px; width: 100%; max-height: 80vh; overflow-y: auto; padding: 22px 24px;
  }
  .status-modal-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
  .status-modal-header h3 { font: 600 17px/1.3 var(--font-display); margin: 0; }
  .status-modal-close { background: none; border: none; font-size: 22px; line-height: 1; color: var(--slate); cursor: pointer; padding: 2px 6px; }
  .status-modal-close:hover { color: var(--ink); }
  .status-modal-empty { color: var(--slate); font-size: 14px; margin: 0; }
  .status-incident { padding: 12px 0; border-top: 1px solid var(--border); }
  .status-incident:first-child { border-top: none; padding-top: 0; }
  .status-incident-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
  .status-incident-name { font: 600 14px/1.3 var(--font-display); }
  .status-incident-status { font-size: 12px; color: var(--slate); text-transform: capitalize; }
  .status-incident-body { font-size: 13.5px; color: var(--ink); margin: 0 0 6px; }
  .status-incident-time { font-size: 12px; color: var(--slate-soft); margin: 0; }
  .status-modal-link { display: inline-block; margin-top: 14px; font-size: 13px; color: var(--accent); text-decoration: none; }
  .status-modal-link:hover { text-decoration: underline; }
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
${dependenciesHtml}

</div>

<div class="status-modal-backdrop" id="dep-modal-backdrop" hidden>
  <div class="status-modal" role="dialog" aria-modal="true" aria-labelledby="dep-modal-title">
    <div class="status-modal-header">
      <h3 id="dep-modal-title"></h3>
      <button type="button" class="status-modal-close" id="dep-modal-close" aria-label="Close">&times;</button>
    </div>
    <div class="status-modal-body" id="dep-modal-body"></div>
    <a class="status-modal-link" id="dep-modal-link" href="#" target="_blank" rel="noopener">View full status page &rarr;</a>
  </div>
</div>

<footer class="site-footer">
  &copy; <span id="copyright-year"></span> Ross Mackenzie
  &middot; <a href="/privacy.html">Privacy policy</a>
</footer>

<script id="dep-data" type="application/json">${dependencyDataJson}</script>
<script>
document.getElementById('copyright-year').textContent = new Date().getFullYear();

(function () {
  var depData = JSON.parse(document.getElementById('dep-data').textContent);
  var backdrop = document.getElementById('dep-modal-backdrop');
  var titleEl = document.getElementById('dep-modal-title');
  var bodyEl = document.getElementById('dep-modal-body');
  var linkEl = document.getElementById('dep-modal-link');

  function openModal(key) {
    var dep = depData[key];
    if (!dep) return;
    titleEl.textContent = dep.name;
    bodyEl.innerHTML = dep.bodyHtml;
    linkEl.href = dep.pageUrl;
    backdrop.hidden = false;
  }
  function closeModal() {
    backdrop.hidden = true;
  }

  document.querySelectorAll('.status-dep-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { openModal(btn.dataset.dep); });
  });
  backdrop.addEventListener('click', function (e) {
    if (e.target === backdrop) closeModal();
  });
  document.getElementById('dep-modal-close').addEventListener('click', closeModal);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !backdrop.hidden) closeModal();
  });
})();
</script>
</body>
</html>`;
}

module.exports = { renderStatusPage };
