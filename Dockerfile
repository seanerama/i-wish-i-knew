# I Wish I Knew — service + worker + console image (ADR-0001, docs/walking-skeleton.md).
#
# Multi-stage: `build` compiles the TypeScript workspaces; `runtime` installs
# production dependencies only and copies an explicit list of paths (never
# `COPY . .`, so nothing depends on .dockerignore to keep secrets or local
# state out of the image). Base image pinned by tag AND digest (multi-arch
# index digest of node:22-alpine, obtained with `docker buildx imagetools
# inspect node:22-alpine`); bump both together.
#
# Multi-arch (ADR-0004, stage 4): release.yml builds linux/amd64 + linux/arm64
# with buildx. The `build` stage runs on the BUILD platform (tsc output is
# plain JS, identical for every target), so only the runtime stage's
# `npm ci --omit=dev` runs under emulation.
#
#   docker build -t i-wish-i-knew:ci .
#   docker run --rm -e DATABASE_URL=... -e IWIK_KEK=... i-wish-i-knew:ci node packages/service/dist/migrate.js
#   docker run --rm -p 3000:3000 -e DATABASE_URL=... -e IWIK_KEK=... i-wish-i-knew:ci

FROM --platform=$BUILDPLATFORM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/runner/package.json packages/runner/package.json
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
# The runner (`iwik`) is a member-side package and is not shipped in this
# image (stage 3 review). It is removed from the workspace list before the
# install, so npm prunes the runner link and its own dependencies (commander)
# from the tree. Every remaining version still comes from package-lock.json;
# `npm install` is used because `npm ci` refuses a manifest that differs from
# the lockfile's workspace list, and the build stage's `npm ci` above has
# already failed the build if the committed lockfile were out of sync. The
# last line fails the build loudly if runner code ever leaks back in.
RUN node -e "const fs = require('fs'); const p = JSON.parse(fs.readFileSync('package.json', 'utf8')); p.workspaces = p.workspaces.filter((w) => w !== 'packages/runner'); fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');" \
    && npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && test ! -e node_modules/commander \
    && test ! -e node_modules/@iwik/runner \
    && test ! -e node_modules/i-wish-i-knew \
    && test -e node_modules/@iwik/contracts
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/packages/service/dist packages/service/dist
COPY packages/service/migrations packages/service/migrations
COPY packages/service/views packages/service/views
COPY packs packs
COPY contracts/schema contracts/schema
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "packages/service/dist/server.js"]
