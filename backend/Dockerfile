FROM node:20-alpine

# Needed to remux a finished recording (raw .ts from the rtmp container) into
# a proper, seekable .mp4 before uploading it - see src/recordings.js.
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .
RUN mkdir -p data uploads

EXPOSE 4000

CMD ["node", "src/index.js"]
