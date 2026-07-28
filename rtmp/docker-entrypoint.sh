#!/bin/sh
set -e

: "${WEBHOOK_SECRET:?WEBHOOK_SECRET environment variable is required}"

envsubst '${WEBHOOK_SECRET}' \
    < /usr/local/nginx/conf/nginx.conf.template \
    > /usr/local/nginx/conf/nginx.conf

# This entrypoint runs as root, but nginx's worker processes (and anything
# they exec, like record-start.sh and the ffmpeg it spawns) drop to the
# unprivileged "nobody" user - the default for this from-source build,
# since nginx.conf.template sets no explicit `user` directive. A brand new
# Docker volume is created root-owned, so without this, "nobody" can't
# write into /recordings at all - mkdir/ffmpeg just fail silently the
# first time recording is ever turned on, with nothing to show for it.
mkdir -p /recordings/raw
chown -R nobody:nobody /recordings

exec /usr/local/nginx/sbin/nginx -g "daemon off;"
