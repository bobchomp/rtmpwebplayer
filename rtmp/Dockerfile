FROM alpine:3.24 AS build

RUN apk add --no-cache build-base pcre2-dev zlib-dev openssl-dev linux-headers git wget

# nginx stable branch (even minor version). nginx-rtmp-module has no recent
# release, so it's pinned to a commit rather than whatever master is at
# build time - bump both deliberately and test a stream on dev first.
ARG NGINX_VERSION=1.30.6
ARG NGINX_RTMP_COMMIT=6c7719d0ba32e00b563ec70bd43dad11960fa9c4

RUN wget -q https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz \
    && tar xzf nginx-${NGINX_VERSION}.tar.gz \
    && git init -q nginx-rtmp-module \
    && git -C nginx-rtmp-module fetch -q --depth 1 https://github.com/arut/nginx-rtmp-module.git ${NGINX_RTMP_COMMIT} \
    && git -C nginx-rtmp-module checkout -q FETCH_HEAD

# -Wno-error: nginx builds with -Werror, and newer compilers keep adding
# warnings the (old) rtmp module trips; a warning shouldn't fail the build.
RUN cd nginx-${NGINX_VERSION} \
    && ./configure \
        --prefix=/usr/local/nginx \
        --with-http_ssl_module \
        --with-cc-opt="-Wno-error" \
        --add-module=../nginx-rtmp-module \
    && make -j"$(nproc)" \
    && make install

FROM alpine:3.24

RUN apk add --no-cache pcre2 zlib openssl ca-certificates gettext ffmpeg curl

COPY --from=build /usr/local/nginx /usr/local/nginx

COPY nginx.conf.template /usr/local/nginx/conf/nginx.conf.template
COPY docker-entrypoint.sh /docker-entrypoint.sh
COPY relay-start.sh /usr/local/bin/relay-start.sh
COPY relay-stop.sh /usr/local/bin/relay-stop.sh
COPY record-start.sh /usr/local/bin/record-start.sh
COPY record-stop.sh /usr/local/bin/record-stop.sh
RUN chmod +x /docker-entrypoint.sh /usr/local/bin/relay-start.sh /usr/local/bin/relay-stop.sh \
    /usr/local/bin/record-start.sh /usr/local/bin/record-stop.sh

EXPOSE 1935 8080

ENTRYPOINT ["/docker-entrypoint.sh"]
