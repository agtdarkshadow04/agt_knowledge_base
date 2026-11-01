FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS frontend-build
ENV VITE_API_URL=/api \
    VITE_AUTH_MODE=local
COPY . .
RUN npm run build

FROM dependencies AS server-build
COPY . .
RUN npx esbuild \
    backend/local-server.ts \
    scripts/migrate.ts \
    scripts/manage-local-user.ts \
    --bundle \
    --packages=external \
    --platform=node \
    --format=esm \
    --outbase=. \
    --outdir=server

FROM node:22-alpine AS api
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=server-build --chown=node:node /app/server ./server
USER node
EXPOSE 3001
CMD ["node", "server/backend/local-server.js"]

FROM nginx:alpine AS web
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build /app/dist /usr/share/nginx/html
EXPOSE 80
