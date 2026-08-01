// Set only on the dev/staging stack's backend (see docker-compose.yml's
// dev-backend service) - never on production. Lets pages visibly warn
// they're on the dev site without the two deployments needing different
// HTML source files.
const IS_DEV_SITE = process.env.IS_DEV_SITE === 'true';

function bannerHtml(position) {
  return `
<div style="position:${position};top:0;left:0;right:0;z-index:99999;background:#facc15;color:#1a1a1a;
display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap;
padding:10px 16px;font:600 14px/1.4 -apple-system,'Segoe UI',Roboto,sans-serif;
box-shadow:0 1px 4px rgba(0,0,0,.2);">
  <span>&#9888;&#65039; This is the <strong>development</strong> site &mdash; not for real streams or production use.</span>
  <a href="https://stream.rossmackenzie.co.uk" style="background:#1a1a1a;color:#fff;
  padding:6px 14px;border-radius:4px;text-decoration:none;font-weight:600;white-space:nowrap;">Go to main site</a>
</div>`.trim();
}

// Only ever adds the banner when actually running as the dev site - a no-op
// (returns html unchanged) everywhere else, including in production.
//
// `overlay: true` is for the full-page video player (see routes/watch.js) -
// that page is a fixed 100vh layout with overflow hidden, so a normal
// document-flow banner pushing content down would clip the bottom of the
// video. An `overlay` banner is `position: fixed` instead of `sticky`, so it
// floats on top of the video rather than resizing it.
function withDevBanner(html, { overlay } = {}) {
  if (!IS_DEV_SITE) return html;
  return html.replace('<body>', `<body>\n${bannerHtml(overlay ? 'fixed' : 'sticky')}`);
}

const DEV_SITE_LINK_PATTERN = /<!-- dev-site-link:start -->[\s\S]*?<!-- dev-site-link:end -->/;

// The homepage has a "Development site" button wrapped in these markers,
// pointing the other way (production -> dev) from withDevBanner's "Go to
// main site" link - only useful on production, since dev already shows that
// link in its own banner and pointing it at itself would be pointless.
function stripDevSiteLinkOnDevSite(html) {
  if (!IS_DEV_SITE) return html.replace(/<!-- dev-site-link:(start|end) -->/g, '');
  return html.replace(DEV_SITE_LINK_PATTERN, '');
}

module.exports = { IS_DEV_SITE, withDevBanner, stripDevSiteLinkOnDevSite };
