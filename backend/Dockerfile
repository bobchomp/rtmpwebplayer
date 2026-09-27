FROM node:20-alpine

# Needed to remux a finished recording (raw .ts from the rtmp container) into
# a proper, seekable .mp4 before uploading it - see src/recordings.js.
#
# font-dejavu + fontconfig: sharp (statsTemplateExport.js's chart image)
# rasterizes an SVG via librsvg, which needs an actual installed font to
# draw any text at all - without one, every label renders as empty tofu
# boxes instead of failing loudly, since alpine ships with zero fonts by
# default.
RUN apk add --no-cache ffmpeg font-dejavu fontconfig && fc-cache -f

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .
RUN mkdir -p data uploads

EXPOSE 4000

CMD ["node", "src/index.js"]
