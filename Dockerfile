# I Wish I Knew — service + worker + console image (ADR-0001, docs/walking-skeleton.md).
#
# Multi-stage: `build` compiles the TypeScript workspaces; `runtime` installs
# production dependencies only and copies an explicit list of paths (never
# `COPY . .`, so nothing depends on .dockerignore to keep secrets or local
# state out of the image). Base image pinned by tag AND digest (multi-arch
# index digest of node:22-alpine, obtained with `docker buildx imagetools
# inspect node:22-alpine`); bump both together.
#
#   docker build -t i-wish-i-knew:ci .
#   docker run --rm -e DATABASE_URL=... -e IWIK_KEK=... i-wish-i-knew:ci node packages/service/dist/migrate.js
#   docker run --rm -p 3000:3000 -e DATABASE_URL=... -e IWIK_KEK=... i-wish-i-knew:ci

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/service/package.json packages/service/package.json
RUN npm ci
COPY packages/contracts packages/contracts
COPY packages/service packages/service
RUN npm run build -w @iwik/contracts && npm run build -w @iwik/service

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/service/package.json packages/service/package.json
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/packages/service/dist packages/service/dist
COPY packages/service/migrations packages/service/migrations
COPY packages/service/views packages/service/views
COPY packs packs
COPY contracts/schema contracts/schema
COPY scripts scripts
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "packages/service/dist/server.js"]
