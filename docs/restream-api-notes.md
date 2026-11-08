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
- Scope: `channels.read channels.write stream.read` (set in `restream.js`'s
  `OAUTH_SCOPE`). `channels.write` was added for title sync (below);
  connections made before that need reconnecting, tracked by the `scope`
  stored on each `db.restreamAccounts` entry.
  There is no dedicated "analytics" scope - viewer analytics come back
  under `stream.read`.
- Only the **refresh token** is persisted, one per dashboard account
  (`db.restreamAccounts[<account email>].refreshToken`, set by
  `routes/restreamAuth.js`'s `/callback`). Every API call first
  exchanges it for a fresh access token (`restreamSession.js`'s
  `getAccessToken()` -> `restream.js`'s `refreshAccessToken()`) rather than
  caching an access token with its own expiry to track.
- Connect/disconnect/status live at `routes/restreamAuth.js` -
  `/connect`, `/callback`, `/disconnect`, `/status`. Per dashboard account,
  not per channel; imports only match an account's own channels.

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

## Title sync

`restreamTitleSync.js` sends a channel's title and description to every
active Restream destination via **`PATCH /user/channel-meta/{channelId}`**
(`{ "title", "description" }`, empty body on success, needs
`channels.write`). Destinations and their `active` flag come from
**`GET /user/channel/all`** (a bare array of `{ id, streamingPlatformId,
url, displayName, active }`). It's opt-in per channel
(`channel.restreamTitleSync`) and runs when the channel goes live, when the
title is saved, and when the setting is switched on. The result is stored
on the channel as `restreamTitleSyncStatus` and shown on the channel page.

An earlier attempt was removed because it targeted Restream's own "Show"
screen, which runs on a private backend (`website-backend.restream.io`)
the API can't reach. channel-meta doesn't change that screen either - it
sets what each destination platform (YouTube, Facebook) shows, which is
what viewers actually see.
