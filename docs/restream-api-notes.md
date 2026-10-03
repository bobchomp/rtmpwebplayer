# Restream API notes

Working notes on Restream's Developer API, gathered the hard way across
several debugging sessions. Read this before touching anything under
`backend/src/restream*.js` - it'll save re-discovering the same gotchas.

## What this app actually uses it for

One Restream account connects to the whole deployment (not per-channel -
see `restreamAuth.js`'s connect route). The only consumer right now is
**Import from Restream** on the Stats page: pulling historical YouTube/
Facebook view counts for past streams into `plays.json` (`restreamImport.js`).

A title-sync feature (keeping a channel's title/description pushed to
Restream) was built and then **fully removed** - see the "Dead ends"
section below before trying to rebuild anything like it.

## Auth

- OAuth2, authorization-code flow. `RESTREAM_CLIENT_ID` /
  `RESTREAM_CLIENT_SECRET` / `RESTREAM_REDIRECT_URI` env vars.
- Scope: `channels.read stream.read` (set in `restream.js`'s `OAUTH_SCOPE`).
  There is no dedicated "analytics" scope - viewer analytics come back
  under `stream.read`.
- Only the **refresh token** is persisted (`db.restream.refreshToken`,
  set by `routes/restreamAuth.js`'s `/callback`). Every API call first
  exchanges it for a fresh access token (`restreamSession.js`'s
  `getAccessToken()` -> `restream.js`'s `refreshAccessToken()`) rather than
  caching an access token with its own expiry to track.
- Connect/disconnect/status live at `routes/restreamAuth.js` -
  `/connect`, `/callback`, `/disconnect`, `/status`. Account-wide, so
  there's nothing per-channel to configure here.

## Base URL and endpoints used

`https://api.restream.io/v2` (overridable via `RESTREAM_API_BASE` for
pointing at a local mock server in tests - see `restream.js`).

- **`GET /user/events/history`** - past stream events. **Paginated**
  (confirmed against a live account): response shape is
  `{ items: [...], pagination: { page, pages_total, limit } }`, 10 items
  per page. Items come back **newest-first**. See "Gotchas" below - this
  one cost a whole debugging session.
- **`GET /user/channels`** - the account's destination channels:
  `{ channels: [{ id, platformId, channelUrl, displayName }] }`.
  `platformId` is an opaque Restream-internal number, not a platform
  name - tell YouTube/Facebook apart by substring-matching `channelUrl`
  instead (`platformFromUrl()` in `restream.js`).
- **`GET /user/events/{id}/analytics/viewers`** - per-event viewer stats:
  `{ total: {...}, byChannel: { "<channelId>": { mean, max, viewsTotal,
  peakTime, watchedTime, viewersPerMinute } } }`. Returns a **404** for an
  event with no analytics yet (e.g. too recent, or never had any viewers) -
  treat that as "no views", not a hard failure (`restream.js`'s
  `getEventAnalytics()` callers already do this via `.catch(() => null)`).

Each event object: `{ id, showId, status, title, description, isInstant,
isRecordOnly, coverUrl, scheduledFor, startedAt, finishedAt,
destinations: [{ channelId, externalUrl, streamingPlatformId }] }`.
`scheduledFor`/`startedAt`/`finishedAt` are unix epoch **seconds**, not
milliseconds.

## Gotchas

- **`/user/events/history`'s `from`/`to` query params don't filter
  anything server-side**, despite looking like they should. Confirmed
  against a live account - the endpoint just returns full history
  regardless of what's passed. Any date-range filtering has to happen
  client-side, after fetching.
- **It's also paginated, and a plain request only returns page 1.**
  Combined with the point above, importing a date range older than
  whatever's on page 1 used to come back completely empty - "No streams
  with YouTube/Facebook views found in that range" looked identical to
  there genuinely being nothing there. Fixed in `listEventHistory()`
  (`restream.js`) by walking pages forward (newest-first) until a whole
  page is older than the requested `from`, or `pages_total` is reached -
  don't revert this to a single unpaginated call.
- **Channel attribution is done by timing, not anything Restream knows
  about.** Restream has no concept of this app's channels - an imported
  event gets matched to a local channel purely by overlapping its
  `startedAt`/`finishedAt` against `recordings.json` (preferred) or
  `plays.json` website-visit timestamps (fallback) - see
  `restreamMatch.js`. This only works because the connected Restream
  account only ever has one stream live at a time; if that ever stops
  being true, this whole matching approach needs rethinking.
- **Imported rows need the event's own title** (`event.title`, carried
  through `restreamImport.js` as `item.restreamTitle`), not the local
  channel's *current* title/description - those are whatever the channel
  happens to be set to *today*, not what was actually live during that
  historical stream. There's no per-event description available from the
  API, so imported rows leave that blank rather than mislabeling it with
  the channel's current one.

## Dead ends - don't retry without reading this first

**Per-channel title sync to Restream was attempted and fully removed.**
The goal was to push this app's channel title/description to Restream so
it'd show up on Restream's own "Show" screen. That screen turns out to run
on a **completely separate, undocumented, private backend**
(`website-backend.restream.io`) that the public Developer API - the one
covered by this whole document, and the only one an OAuth app can reach -
has no access to at all. The public API's `channels.read`/`stream.read`
scopes only cover what's documented above; there is no way to push
metadata that affects what Restream's Studio/Show UI displays. Confirmed
by inspecting Restream's own web app's network traffic, not just API
docs. Don't re-attempt this without first finding an actual, documented,
OAuth-reachable way to write to a Show - as of this writing, there isn't
one.
