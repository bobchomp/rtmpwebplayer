#!/bin/sh
set -e

: "${WEBHOOK_SECRET:?WEBHOOK_SECRET environment variable is required}"

envsubst '${WEBHOOK_SECRET}' \
    < /usr/local/nginx/conf/nginx.conf.template \
    > /usr/local/nginx/conf/nginx.conf

exec /usr/local/nginx/sbin/nginx -g "daemon off;"
