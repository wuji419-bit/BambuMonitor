FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ffmpeg \
    tini \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/core ./core
COPY --from=build --chown=node:node /app/src/utils ./src/utils
COPY --from=build --chown=node:node /app/electron/camera-stream.cjs ./electron/camera-stream.cjs

RUN mkdir -p /app/data \
  && chown node:node /app/data

ENV NODE_ENV=production PORT=3080 DATA_DIR=/app/data

EXPOSE 3080
VOLUME ["/app/data"]

USER node

ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","server/index.js"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node","server/healthcheck.js"]
