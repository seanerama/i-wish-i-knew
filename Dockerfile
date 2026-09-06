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
# `npm install --omit=dev` runs under emulation.
#
# Hardening (stage 12, issue #18): the runtime stage carries NO package
# manager. The npm CLI (with corepack and the bundled yarn) is deleted right
# after the production install, in the same layer, and the build fails if
# `/usr/local/bin/npm` survives. The base's OpenSSL is upgraded to the
# patched Alpine package. release.yml and ci.yml (`release-dry-run`) scan the
# result with Trivy at HIGH/CRITICAL (fixable only) and fail on any finding;
# the same scan locally:
#
#   docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:0.69.0 \
#     image --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 i-wish-i-knew:ci
#
# Base: node:22-alpine = Node 22.23.2 on Alpine 3.24.1 (index digest below,
# verified current on 2026-09-06; /etc/alpine-release in the image says 3.24.1).
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
# The base ships libssl3/libcrypto3 3.5.7-r0 (CVE-2026-14456, HIGH, fixed in
# 3.5.8-r0). Take the patched Alpine 3.24 package instead of ignoring the
# finding; drop this line once the pinned base already carries >= 3.5.8-r0.
# Version observed after the upgrade on 2026-09-06: 3.5.8-r0.
RUN apk upgrade --no-cache libssl3 libcrypto3
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
# `test !` lines fail the build loudly if runner code ever leaks back in.
#
# Then (stage 12) the npm CLI is removed from the image in the same layer:
# nothing at runtime runs npm (CMD and the migrate entrypoint are plain
# `node`), and the CLI's bundled dependencies (tar, pacote, sigstore, ...)
# were the only HIGH/CRITICAL findings outside the base OS. corepack and the
# bundled yarn go with it for the same reason. The final `test !` lines make
# a base-image bump that reintroduces a package manager fail the build.
RUN node -e "const fs = require('fs'); const p = JSON.parse(fs.readFileSync('package.json', 'utf8')); p.workspaces = p.workspaces.filter((w) => w !== 'packages/runner'); fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');" \
    && npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && test ! -e node_modules/commander \
    && test ! -e node_modules/@iwik/runner \
    && test ! -e node_modules/i-wish-i-knew \
    && test -e node_modules/@iwik/contracts \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
        /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
        /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* /root/.npm \
    && test ! -e /usr/local/bin/npm \
    && test ! -e /usr/local/bin/npx \
    && test ! -e /usr/local/lib/node_modules/npm \
    && test ! -e /usr/local/bin/corepack \
    && test ! -e /usr/local/bin/yarn
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
