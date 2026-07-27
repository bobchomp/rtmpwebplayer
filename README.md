# RTMP Web Player

Self-hosted live streaming stack: create a channel, get an RTMP URL + stream
key to paste into Restream (or any RTMP-capable encoder), and get back an
`<iframe>` embed you paste into your own website. The embed automatically
shows an offline placeholder and switches to live video the moment you start
streaming - no page reload needed.

## How it works

```
Restream ──RTMP──▶ nginx-rtmp (ingest + HLS)
                          │
                          │ on_publish / on_publish_done webhooks
                          ▼
                     backend (Express)
                       - admin dashboard (create/manage channels)
                       - proxies HLS playback by public channel id
                         (the RTMP stream key never reaches a browser)
                       - serves the embeddable player page
                          ▲
                          │ HTTPS (via Caddy, auto-TLS)
                          │
                    your website's iframe embed
```

- **rtmp/** - nginx compiled with the RTMP module. Accepts RTMP publishes on
  port 1935, remuxes to HLS internally. Only reachable by the backend, never
  exposed to the internet directly.
- **backend/** - Node/Express app: admin dashboard, channel API, RTMP
  webhook handlers, HLS reverse proxy, and the embed player page.
- **caddy/** - reverse proxy that terminates HTTPS automatically (Let's
  Encrypt) and forwards everything to the backend.

### Security note on stream keys

Each channel has a secret stream key (used only to *publish*, i.e. what you
put into Restream) and a public channel id (used in the embed code). The
embed page and all public URLs only ever reference the channel id - the
backend looks up the real stream key server-side to fetch HLS segments, so
the secret key is never visible in page source, network requests, or embed
code. Regenerating a channel's key immediately invalidates the old one.

## 1. Prerequisites

- A Linux server (VPS) with Docker and Docker Compose installed, and root/
  sudo access. A $5-6/mo droplet (DigitalOcean, Hetzner, Linode, etc.) is
  enough - see cost notes below.
- A domain name with an A record pointed at the server's IP (needed for
  automatic HTTPS via Caddy). You can test locally without one first.
- Ports open on the server's firewall: **1935/tcp** (RTMP ingest), **80/tcp**
  and **443/tcp** (dashboard + player, HTTPS).

## 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:

- `PUBLIC_HOST` - your domain (e.g. `stream.example.com`), or the server's
  IP for local testing without HTTPS.
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` - your dashboard login. Use a strong,
  unique password - this is the only account and it's what stands between
  the internet and your channel management.
- `SESSION_SECRET` / `WEBHOOK_SECRET` - generate each with:
  ```bash
  openssl rand -hex 32
  ```

## 3. Run it

```bash
docker compose up -d --build
```

First build compiles nginx from source (a couple of minutes). After that:

- Dashboard: `http://<server-ip>:4000` (or `https://<PUBLIC_HOST>` once DNS
  + Caddy are working)
- RTMP ingest: `rtmp://<server-ip-or-domain>:1935/live`

Log in, click **Create channel**, give it a name. You'll get:

- An **RTMP URL** (shared across all channels: `rtmp://<host>:1935/live`)
- A **stream key** (unique per channel, secret)
- An **embed code** you can copy straight into your website

## 4. Point your encoder at it

Click into the channel you just created. Its detail page opens with a
**"Connect your encoder"** panel (this is what shows whenever the channel
isn't live) - copy the **RTMP URL** and **stream key** shown there straight
into your encoder (OBS, vMix, or a service like Restream if you're using
one as a relay). There's no separate username/password to configure - the
stream key itself is the secret.

The moment your encoder starts pushing, that panel is replaced by a real
live preview of the stream right there in the dashboard, and the channel
flips to "live" for anyone viewing the embed too.

## 5. Embed the player

Paste the embed code from the dashboard into your website's HTML, e.g.:

```html
<iframe
  src="https://stream.example.com/embed/<channel-id>"
  style="width:100%;aspect-ratio:16/9;border:0;"
  allow="autoplay; fullscreen"
  allowfullscreen
  loading="lazy">
</iframe>
```

It shows your default offline placeholder (or a custom cover image you
upload per-channel from the dashboard) until you go live, then switches to
the video automatically. Viewers can unmute/control playback with the
native video controls (it starts muted so autoplay isn't blocked by
browsers).

### Restricting embedding to your own site(s)

By default the embed is playable anywhere - anyone who copies the
`<iframe>` code, or even just the raw `/live/...` video URLs, can put your
stream on their own site. To lock this down, set in `.env`:

```
ALLOWED_EMBED_DOMAINS=yourdomain.com,www.yourdomain.com
```

and restart (`docker compose up -d --build`). This enforces the
restriction two ways - the same mechanism behind YouTube's own "restrict
embedding to certain domains" setting:

- The embed page sends a `Content-Security-Policy: frame-ancestors` header,
  so browsers refuse to render your `<iframe>` at all on any site not
  listed - stops someone copy-pasting your embed code onto their own page.
- The video proxy checks the `Referer` header on each request, so someone
  bypassing the iframe entirely (building their own player pointed
  directly at your `/live/...` URLs) gets blocked too.

Leave it unset to keep the original open-embed-anywhere behavior.

## Scaling to many concurrent viewers (Cloudflare CDN)

The backend's HLS proxy is lightweight, but if you expect many concurrent
viewers (dozens to hundreds+), put Cloudflare's free CDN in front of your
domain (proxied/orange-cloud DNS). HLS playback is just small chunked files
over plain HTTPS, so Cloudflare can cache and fan them out to every viewer
without your origin server serving each one directly. This keeps your VPS
bill flat regardless of audience size. Steps:

1. Add your domain to Cloudflare, point the A record at your server with
   the proxy (orange cloud) enabled.
2. Set Cloudflare's SSL mode to "Full (strict)" - Caddy's automatic cert
   makes this straightforward.
3. Add a Cache Rule matching **URI Path starts with `/live/`**, set to
   "Eligible for cache" (not the paid Cache Reserve add-on - the free,
   standard Cache Rules feature is all that's needed here). It'll respect
   the origin's `Cache-Control` headers, which the backend already sets to
   short lifetimes appropriate for live segments.
4. Set `RTMP_PUBLIC_HOST` in `.env` to your server's raw IP address (not
   the domain). Cloudflare's free plan only proxies standard web ports
   (80/443), not RTMP's port 1935 - so Restream must keep connecting via
   the IP directly, and this setting makes the dashboard display that IP
   as the RTMP URL instead of the (now-proxied) domain. `PUBLIC_HOST` stays
   as your domain for everything else (embed links, HTTPS).

With a CDN in front, the first few seconds after an encoder connects can be
unreliable (nginx hasn't written a real HLS segment yet, and the very first
requests through a CDN can take a little longer to settle) - see
`LIVE_DELAY_MS` below for how the app avoids showing "live" during that
window.

## Cost estimate

| Item | Notes | Cost |
|---|---|---|
| VPS | 1-2 vCPU / 1-2GB RAM is enough (remux only, no transcoding) | ~$5-12/mo |
| Cloudflare CDN | Free tier | $0 |
| Domain | If you don't already have one | ~$10-15/yr |

## Local testing without a domain

Set `PUBLIC_HOST=localhost` (or your machine's LAN IP) in `.env` and skip
Caddy - hit the backend directly at `http://localhost:4000`. You can test
RTMP publishing with `ffmpeg`:

```bash
ffmpeg -re -i some-video.mp4 -c copy -f flv rtmp://localhost:1935/live/<stream-key>
```

Then open `http://localhost:4000/embed/<channel-id>` to watch it.

## Managing channels

The dashboard's channel list is a simple picker - click a channel to open
its detail page, laid out like Restream's own dashboard: what's actually
streaming on the left, the outputs it fans out to on the right.

- **Left panel**: shows "Connect your encoder" (RTMP URL + stream key) when
  offline, or a real live preview of the stream once you're live.
- **Regenerate key**: rotates a channel's stream key immediately; update
  whatever's pushing to it with the new key. Useful if a key ever leaks.
- **Delete channel**: removes it, its uploaded images, and any custom
  outputs. The embed URL for that channel stops working.
- **Cover/thumbnail images**: at the bottom of the detail page - upload as
  many as you like to each gallery, click one to make it active. PNG/JPEG/
  WebP, up to 5MB each.

## Outputs: relaying to other platforms

The right panel on a channel's detail page lists everywhere that channel's
stream goes:

- **Your Website** - the embed player itself (see above). Has its own
  on/off toggle: switching it off makes the embed page and video URLs
  return "not found" to everyone except you (your own dashboard preview
  keeps working, since it's a genuinely useful way to confirm a stream is
  live even if you're not publishing it to your site) - handy if a channel
  is only ever meant to go to YouTube or a custom output.
- Everything else - YouTube and custom RTMP destinations - is added via the
  **+ Add output** button and shows up in the same list below "Your
  Website", each with its own on/off toggle and a Delete button. There's no
  limit on how many of each type a channel can have (up to 10 outputs
  total), so you can relay to several YouTube channels and/or several
  custom RTMP destinations at once.
  - **Custom RTMP**: picking this in the popup asks for a name, RTMP URL,
    and stream key (the same fields Restream or any platform gives you for
    a "custom RTMP" destination - Twitch, Facebook, another server, etc).
  - **YouTube**: see the dedicated section below - picking this in the
    popup takes you straight to Google's sign-in.

## Viewer stats

Click **Stats** next to Log out to see who's watched each channel - one row
per viewer's watch session (starting playback again after a 30+ minute gap
counts as a new row; anything within that just updates "Latest Play"), with
Latest Play, Channel, Title (whatever the stream's title was set to at the
time), Type (Mobile/Desktop), IP Address, Country, Region, City, and First
Play. Filter by channel and/or date range, and export the currently-filtered
rows as a CSV via the **Export CSV** button.

Country/Region/City need an IP-to-location lookup, which is optional:

1. Sign up for a free account at
   [maxmind.com/en/geolite2/signup](https://www.maxmind.com/en/geolite2/signup).
2. Under your account, go to **My License Key** and generate one.
3. Set `GEOIP_LICENSE_KEY` in `.env` to that key and restart the backend.

The backend downloads MaxMind's free GeoLite2 City database on startup (and
refreshes it weekly to keep boundaries current) - no key means those three
columns just stay blank; everything else on the Stats page works either way.

## Relaying to YouTube

Unlike a plain RTMP destination, YouTube needs an account connected via
OAuth - after that it creates a live broadcast with your channel's title
automatically every time you go live, no need to touch YouTube Studio or
paste stream keys manually. Each YouTube connection is independent, so a
channel can relay to several different YouTube channels at once (or a
custom RTMP destination and a YouTube one simultaneously) - just click
"+ Add output" again for each one.

### One-time Google Cloud setup

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com)
2. **APIs & Services → Library** - enable the **YouTube Data API v3**
3. **APIs & Services → OAuth consent screen** (Google's newer UI splits this
   across a few pages):
   - **Audience**: user type External; add your own Google account under
     **Test users** (this avoids Google's full public-app verification
     process, which isn't needed for personal use)
   - **Data access**: add the scope `.../auth/youtube`
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**,
   application type **Web application**, with an authorized redirect URI of:
   ```
   https://<PUBLIC_HOST>/api/youtube/callback
   ```
5. Add the resulting Client ID/Secret to `.env`:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=https://<PUBLIC_HOST>/api/youtube/callback
   ```
   then `docker compose up -d --build`.

### Using it

- On a channel's detail page, click **+ Add output**, then **YouTube** in
  the popup - this takes you to Google's sign-in, and connects that
  account to this channel specifically.
- The new output shows up in the outputs list as "YouTube - Connected as
  <your channel name>", with its own on/off toggle (takes effect
  immediately). Title and description for the broadcast come from that
  channel's shared **Edit title & description** popup, not a separate
  YouTube-only field.
- When the channel goes live, the app automatically creates a YouTube live
  broadcast (one per enabled YouTube output, if you've connected more than
  one) with that title/description and relays the incoming stream to it
  (`ffmpeg -c copy` - repackaged, not re-encoded, so it's cheap on CPU). The
  broadcast goes live on YouTube automatically once it detects healthy
  incoming data, and completes automatically when the stream ends - no
  manual steps in YouTube Studio either way.
- Deleting a YouTube output (same Delete button as any other output) also
  disconnects that account - other outputs are unaffected.

### How it works, if you're curious

`nginx-rtmp`'s `exec_publish`/`exec_publish_done` hooks (see
`rtmp/relay-start.sh` / `relay-stop.sh`) ask the backend for a relay target
whenever a channel goes live, and spawn/kill the `ffmpeg` relay accordingly.
The backend creates the actual YouTube broadcast+stream via the YouTube
Data API the moment a YouTube-enabled channel starts publishing.

## Production security checklist

- `docker-compose.yml` publishes the backend directly on port **4000** for
  convenience during initial setup/local testing. Once your domain and
  Caddy are confirmed working over HTTPS, **close port 4000 in your
  server's firewall** (e.g. `ufw deny 4000`) so the dashboard is only
  reachable through Caddy's HTTPS. Logging in over plain HTTP sends your
  password and session cookie unencrypted.
- Keep `ADMIN_PASSWORD` strong and unique - it's the only thing protecting
  channel management and viewer analytics.
- `SESSION_SECRET` and `WEBHOOK_SECRET` should be long random values (the
  `openssl rand -hex 32` from step 2) and kept out of version control - copy
  `.env.example` to `.env` and never commit `.env`.

## Troubleshooting

- **Restream says the connection failed**: double check the RTMP URL
  includes `/live` and the stream key is copied exactly (no extra spaces).
  Confirm port 1935 is open in your server's firewall/security group.
- **Dashboard shows "live" but the embed shows offline / errors**: check
  `docker compose logs rtmp` for HLS write errors, and confirm the `rtmp`
  container's `/tmp/hls` volume has space.
- **Login fails**: the admin credentials come from `.env` - restart the
  stack (`docker compose up -d`) after changing them.
- **Caddy isn't getting a certificate**: your DNS A record must already
  point at the server before starting Caddy, and ports 80/443 must be
  reachable from the internet (not just your local network).
