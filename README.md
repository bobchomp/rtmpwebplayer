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

## 4. Point Restream at it

In Restream, add a **Custom RTMP** destination and fill in the fields from
the dashboard:

- **Display name**: anything you like
- **RTMP URL**: the RTMP URL shown on the dashboard, e.g.
  `rtmp://stream.example.com:1935/live`
- **Stream key**: the channel's stream key (click "Show" to reveal, "Copy"
  to copy)
- **Use authentication**: leave off - the stream key itself is the secret;
  there's no separate username/password on the RTMP connection.

When Restream starts pushing to that destination, the channel flips to
"live" within a couple of seconds and anyone viewing the embed sees the
stream automatically.

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
3. Add a Cache Rule (or Page Rule) for `/live/*` to cache by default,
   respecting origin `Cache-Control` headers (the backend already sets short
   cache lifetimes appropriate for live segments).

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

- **Regenerate key**: rotates a channel's stream key immediately; update
  Restream with the new key. Useful if a key ever leaks.
- **Delete channel**: removes it and its uploaded cover image. The embed
  URL for that channel stops working.
- **Cover image**: PNG/JPEG/WebP, up to 5MB, shown whenever the channel
  isn't live. Remove it to revert to the plain "Offline" placeholder.

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
