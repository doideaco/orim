# Orim — single-container build. One process, one port, one data volume.
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --dir apps/web build && pnpm --dir apps/sync build

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/apps/sync/dist/server.mjs ./server.mjs
COPY --from=build /app/apps/web/dist ./web
ENV ORIM_DATA_DIR=/data \
    ORIM_WEB_DIST=/app/web \
    PORT=1234
EXPOSE 1234
# Owned by the runtime user, so named/anonymous volumes initialized from
# the image are writable (the server runs as node, not root).
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
CMD ["node", "server.mjs"]
