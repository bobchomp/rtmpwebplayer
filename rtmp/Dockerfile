FROM alpine:3.19 AS build

RUN apk add --no-cache build-base pcre-dev zlib-dev openssl-dev linux-headers git wget

ARG NGINX_VERSION=1.25.4

RUN wget -q https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz \
    && tar xzf nginx-${NGINX_VERSION}.tar.gz \
    && git clone --depth 1 https://github.com/arut/nginx-rtmp-module.git

RUN cd nginx-${NGINX_VERSION} \
    && ./configure \
        --prefix=/usr/local/nginx \
        --with-http_ssl_module \
        --add-module=../nginx-rtmp-module \
    && make -j"$(nproc)" \
    && make install

FROM alpine:3.19

RUN apk add --no-cache pcre zlib openssl ca-certificates gettext ffmpeg curl

COPY --from=build /usr/local/nginx /usr/local/nginx

COPY nginx.conf.template /usr/local/nginx/conf/nginx.conf.template
COPY docker-entrypoint.sh /docker-entrypoint.sh
COPY relay-start.sh /usr/local/bin/relay-start.sh
COPY relay-stop.sh /usr/local/bin/relay-stop.sh
RUN chmod +x /docker-entrypoint.sh /usr/local/bin/relay-start.sh /usr/local/bin/relay-stop.sh

EXPOSE 1935 8080

ENTRYPOINT ["/docker-entrypoint.sh"]
