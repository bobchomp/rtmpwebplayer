const path = require('path');
const fs = require('fs');

const TEMPLATE = fs.readFileSync(
  path.join(__dirname, 'views', 'embed.html'),
  'utf8'
);

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

// Safely embeds a value as a JS string literal inside an inline <script>
// block. JSON.stringify handles JS-string escaping (quotes, backslashes,
// newlines) and also supplies the surrounding quotes; escaping "<"/">" on
// top of that stops a title/description containing something like
// "</script><script>..." from prematurely closing the script block itself.
function escapeForInlineScript(str) {
  return JSON.stringify(String(str)).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

// Shared by the embed route (iframed on your own site) and the public-link
// watch route (a direct, non-embeddable page) - both show the exact same
// player, just with different framing rules around them.
// options.watchPage: the Public Link page layout - player centred on the
// app's light page with the title, live status and Share underneath, rather
// than the embed's full-window player with the title over the video.
function buildPlayerHtml(channel, options = {}) {
  const displayTitle = channel.title || channel.name;
  const description = channel.description || '';

  // Replacement values are passed as functions, not strings - a string
  // replacement is special-cased by String.replace() itself (`$&`, `$$`,
  // `` $` ``, `$'` are interpreted as backreference tokens instead of
  // literal text), which would silently corrupt the output for a channel
  // name/title/description containing any of those sequences.
  const template = options.watchPage ? TEMPLATE.replace('<html>', '<html class="watch-page" lang="en">') : TEMPLATE;
  return template
    .replace(/__CHANNEL_ID__/g, () => channel.id)
    .replace(/__CHANNEL_NAME__/g, () => escapeHtml(channel.name))
    .replace(/__PAGE_TITLE__/g, () => escapeHtml(displayTitle))
    .replace(/__META_DESCRIPTION__/g, () => escapeHtml(description))
    .replace(/__TITLE_JSON__/g, () => escapeForInlineScript(channel.title || ''))
    .replace(/__DESCRIPTION_JSON__/g, () => escapeForInlineScript(description));
}

module.exports = { buildPlayerHtml };
