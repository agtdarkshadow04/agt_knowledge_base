# syntax=docker/dockerfile:1
# One image (DEP-1): the server serves the API and the built client (SRV-9).
FROM node:26-bookworm-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:26-bookworm-slim AS runtime
# BAK-6: pg_dump and pg_restore from the PGDG apt repository, the same major
# version as the postgres:18 server in docker-compose.yml (never older; a newer
# pg_dump can write statements an older server rejects). The signing key download
# gives up on a stalled connection after 30 s and retries, so one slow response
# from www.postgresql.org does not fail the build.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL --max-time 30 --retry 5 --retry-all-errors --retry-delay 3 \
    -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-18 \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*
# CFG-2: the launcher-set variables. config.yaml's server.host overrides the listen address.
ENV NODE_ENV=production \
    AGT_KNOWLEDGE_BASE_CONFIG_FILE=/app/config.yaml \
    AGT_KNOWLEDGE_BASE_SERVER_HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-server ./dist-server
# DATA-10: all persistent state (pre-restore backups, the restore-failed marker) under one volume.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8081/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "dist-server/index.mjs"]
