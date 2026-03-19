FROM node:20-bookworm-slim

# Accept git commit hash as build arg (for production builds)
ARG GIT_COMMIT=unknown

RUN apt-get update && apt-get install -y --no-install-recommends \
  ffmpeg \
  python3 make g++ \
  gosu \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

RUN groupadd -r birdcam && useradd -r -g birdcam -d /app birdcam \
  && mkdir -p hls data \
  && chown -R birdcam:birdcam /app

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production
ENV GIT_COMMIT=${GIT_COMMIT}
EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server.js"]
