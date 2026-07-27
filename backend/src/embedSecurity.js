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

module.exports = { getAllowedDomains, frameAncestorsHeader, isRefererAllowed };
