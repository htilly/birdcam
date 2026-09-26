#
# Stage 1: build dependencies (compilers and headers stay in this stage)
#
FROM node:22-bookworm-slim AS build

# apt install with retries for transient network/mirror failures.
# Fails the build if all attempts fail.
RUN set -eux; \
    echo 'exit 101' > /usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d; \
    for i in 1 2 3; do \
      if apt-get update && apt-get install -y --no-install-recommends \
           python3 python3-venv python3-dev make g++; then break; fi; \
      if [ "$i" -eq 3 ]; then exit 1; fi; \
      sleep 5; \
    done; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Motion detector (Python) dependencies in a venv (Debian 12 enforces PEP 668,
# so system-wide pip installs are refused). motion/motion.py uses OpenCV etc.
COPY motion/requirements.txt ./motion/requirements.txt
RUN python3 -m venv /opt/venv \
  && /opt/venv/bin/python -m pip install --no-cache-dir -r motion/requirements.txt

# Node dependencies (better-sqlite3 may compile natively here)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

#
# Stage 2: runtime
#
FROM node:22-bookworm-slim

RUN set -eux; \
    echo 'exit 101' > /usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d; \
    for i in 1 2 3; do \
      if apt-get update && apt-get install -y --no-install-recommends \
           ffmpeg python3 gosu; then break; fi; \
      if [ "$i" -eq 3 ]; then exit 1; fi; \
      sleep 5; \
    done; \
    rm -rf /var/lib/apt/lists/*

RUN groupadd -r birdcam && useradd -r -g birdcam -d /app birdcam

WORKDIR /app

# Same base image and path as the build stage, so the venv's python symlink
# (/usr/bin/python3) resolves identically here.
COPY --from=build /opt/venv /opt/venv

# Venv first on PATH so `python3` (motionManager's spawn('python3', ...))
# resolves to /opt/venv/bin/python3. gosu preserves PATH.
ENV PATH="/opt/venv/bin:${PATH}"

COPY --from=build --chown=birdcam:birdcam /app/node_modules ./node_modules
COPY --chown=birdcam:birdcam . .

RUN mkdir -p hls data && chown birdcam:birdcam hls data

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Declared late so a new commit hash doesn't invalidate the cached layers above
ARG GIT_COMMIT=unknown
ENV NODE_ENV=production
ENV GIT_COMMIT=${GIT_COMMIT}
EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server.js"]
