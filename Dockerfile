# syntax=docker/dockerfile:1

# The build output is plain JavaScript: build once on the native platform.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# The server is bundled into a single file: no node_modules at runtime.
FROM node:24-alpine
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    PUID=1000 \
    PGID=1000
WORKDIR /app
COPY --from=build /app/dist ./dist
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO /dev/null "http://127.0.0.1:${PORT}/api/health" || exit 1
# Starts as root to give /data to PUID:PGID, then drops to that user (see privileges.ts).
CMD ["node", "--enable-source-maps", "dist/server/index.js"]
