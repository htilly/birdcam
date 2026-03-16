FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
  ffmpeg \
  python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

RUN groupadd -r birdcam && useradd -r -g birdcam -d /app birdcam \
  && mkdir -p hls data \
  && chown -R birdcam:birdcam /app

USER birdcam

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
