FROM node:26-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci

FROM dependencies AS frontend-build
ENV VITE_API_URL=/api
COPY . .
RUN npm run build:client

FROM dependencies AS server-build
COPY . .
# The API bundle, plus the migration job and the member-recovery CLI at the
# paths docker-compose.yml and the README use.
RUN npm run build:server \
  && npx esbuild scripts/migrate.ts scripts/manage-local-user.ts \
    --bundle --packages=external --platform=node --target=node26 --format=esm \
    --outdir=server-scripts

FROM node:26-alpine AS api
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=server-build --chown=node:node /app/dist-server ./dist-server
COPY --from=frontend-build --chown=node:node /app/dist ./dist
COPY --from=server-build --chown=node:node /app/server-scripts ./server/scripts
# The backups volume inherits this ownership on first use.
RUN mkdir -p /app/data/backups && chown -R node:node /app/data
USER node
EXPOSE 3001
CMD ["node", "dist-server/index.mjs"]

# Nginx only forwards to the API, which serves the client too (SRV-9).
FROM nginx:alpine AS web
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
