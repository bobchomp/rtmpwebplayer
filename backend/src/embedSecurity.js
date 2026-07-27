// Controls which external sites may embed the player / hotlink the video
// feed, via the ALLOWED_EMBED_DOMAINS env var (comma-separated hostnames,
// no protocol - e.g. "example.com,www.example.com"). Empty/unset keeps the
// original open-by-default behavior (embeddable anywhere).

function getAllowedDomains() {
  return (process.env.ALLOWED_EMBED_DOMAINS || '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
}

// CSP value for the embed page itself - stops the *iframe* from rendering
// at all on any site not in the allow-list. Browser-enforced, not spoofable
// by the embedding page.
function frameAncestorsHeader() {
  const domains = getAllowedDomains();
  if (domains.length === 0) return 'frame-ancestors *';
  const sources = domains.map((d) => `https://${d}`).join(' ');
  return `frame-ancestors 'self' ${sources}`;
}

function hostnameFromUrl(value) {
  try {
    return new URL(value).hostname;
  } catch (err) {
    return null;
  }
}

// Guards the HLS proxy endpoints - stops someone bypassing the iframe
// entirely by pointing their own <video>/hls.js directly at our public HLS
// URLs from another site. Requests from our own embed page (same origin as
// PUBLIC_HOST) are always allowed regardless of the allow-list, since that's
// legitimate traffic through the iframe, not a third-party embed.
function isRefererAllowed(req) {
  const domains = getAllowedDomains();
  if (domains.length === 0) return true;

  const referer = req.get('Referer');
  if (!referer) return true; // fail open - some browsers/extensions strip this

  const refererHost = hostnameFromUrl(referer);
  if (!refererHost) return true; // couldn't parse it, don't block on our own uncertainty

  if (refererHost === process.env.PUBLIC_HOST) return true;

  return domains.some((d) => refererHost === d || refererHost.endsWith(`.${d}`));
}

// True when this request is a direct top-level browser navigation (someone
// pasting the embed URL into their address bar), as opposed to being loaded
// as the content of an <iframe>, or fetched by hls.js/a <video> element from
// inside one. frame-ancestors above only restricts *who can iframe this
// page* - it has no effect at all on a direct visit, since there's no
// ancestor frame for the browser to check against - so this is the only way
// to close that gap.
//
// Sec-Fetch-Dest is set by the browser itself based on the actual request
// context and can't be forged by a page's own JavaScript, unlike Referer:
// "document" means a real navigation (address bar, a link, a redirect);
// loading this URL as an <iframe>'s content is "iframe"; hls.js's own
// manifest/segment fetches from inside that iframe are plain fetch()/XHR
// calls ("empty"), and a native <video src> load is "video" - none of those
// are "document", so this only ever catches a genuine direct visit.
// Browsers/clients too old to send Fetch Metadata headers at all don't send
// this header - failing open (allowed) for that case is deliberate: there's
// no way to tell, and blocking every visitor on those browsers outright
// would be a worse failure mode than the narrow gap it leaves.
function isDirectNavigation(req) {
  return req.headers['sec-fetch-dest'] === 'document';
}

module.exports = { getAllowedDomains, frameAncestorsHeader, isRefererAllowed, isDirectNavigation };
