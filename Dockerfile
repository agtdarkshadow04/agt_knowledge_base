FROM node:26-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci

FROM dependencies AS frontend-build
COPY . .
RUN npm run build:client

FROM dependencies AS server-build
COPY . .
# The server bundle (it runs the migrations at startup, DATA-4), plus the
# member-recovery CLI at the path the README uses.
RUN npm run build:server \
  && npx esbuild scripts/manage-local-user.ts \
    --bundle --packages=external --platform=node --target=node26 --format=esm --loader:.sql=text \
    --outdir=server-scripts

FROM node:26-alpine AS api
# CFG-2: the launcher-set variables. config.yaml's server.host overrides the listen address.
ENV NODE_ENV=production \
  AGT_KNOWLEDGE_BASE_CONFIG_FILE=/app/config.yaml \
  AGT_KNOWLEDGE_BASE_SERVER_HOST=0.0.0.0
WORKDIR /app
# BAK-6: pg_dump and pg_restore for backups, the same major version as the
# postgres:16 server in docker-compose.yml (never older; a newer pg_dump can
# write statements a 16 server rejects).
RUN apk add --no-cache postgresql16-client
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=server-build --chown=node:node /app/dist-server ./dist-server
COPY --from=frontend-build --chown=node:node /app/dist ./dist
COPY --from=server-build --chown=node:node /app/server-scripts ./server/scripts
# The backups volume inherits this ownership on first use.
RUN mkdir -p /app/data/backups && chown -R node:node /app/data
USER node
EXPOSE 8081
CMD ["node", "dist-server/index.mjs"]

# Nginx only forwards to the API, which serves the client too (SRV-9).
FROM nginx:alpine AS web
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
