# Stage 4: Release pipeline: multi-arch image to ghcr and staging systemd unit

- **Type:** chore
- **Depends on:** 2
- **Milestone:** 0.1 walking skeleton
- **Work-item:** https://github.com/seanerama/i-wish-i-knew/issues/4
- **Design refs:** ADR-0004; `STATUS.md`; `.verity/deploy-access.README.md`

## Objectives

Give the Release/Deploy Operator (`/verity:ship`) everything it needs to cut
`0.0.1`, publish the image, and bring staging up. This stage builds the
pipeline and the host artifacts; it does **not** perform the deploy (that is
the Operator's job and is confirm-gated).

## What to build

- `.github/workflows/release.yml`: on tag `v*`, build with buildx for
  `linux/amd64,linux/arm64`, push `ghcr.io/seanerama/i-wish-i-knew:<tag>` and
  `:sha-<short>`; `permissions: packages: write`; the image is built from the
  same Dockerfile CI already gates. No deploy step in this workflow.
- `deploy/i-wish-i-knew.service`: systemd unit for the staging host running the
  image via `docker run` (or `podman`) with `EnvironmentFile=/etc/i-wish-i-knew/env`,
  `Restart=on-failure`, health check on `/readyz`, log to journald.
- `deploy/staging/README.md`: host prerequisites (docker, ghcr login, PostgreSQL
  database and role creation SQL, env file template listing variable NAMES only),
  the migration command (`docker run … node packages/service/dist/migrate.js up`),
  and the rollback procedure (redeploy previous tag). Credentials are never in
  the repo; the README points at `.verity/deploy-access.README.md`.
- `deploy/production/README.md`: Coolify application settings to replicate
  (image source, port, health check path, env variable names, Postgres resource),
  written so `/verity:ship` can drive it by API.
- `packages/service/src/migrate.ts` entrypoint if stage 2 did not add one.
- `STATUS.md`: add the environments table skeleton (staging, production) with
  "not deployed" placeholders; the Operator fills real values.

## Interface contracts

- **Exposes:** the tagged image, the systemd unit, and the two deploy READMEs.
- **Consumes:** the stage-2 Dockerfile and `/readyz`.

## Testing requirements

- CI job `release-dry-run` on pull requests touching `Dockerfile`, `deploy/`, or
  `release.yml`: `docker buildx build --platform linux/amd64,linux/arm64` without
  push, to prove the multi-arch build succeeds before a tag is cut.
- `deploy/test/unit-file.test.sh`: `systemd-analyze verify` on the unit file
  (skipped with a visible notice where systemd is absent, never silently).

## Acceptance conditions

- [ ] Clear exit-state defined (what "done" means here): a `v0.0.1-rc` tag on a
      throwaway branch produces a multi-arch image on ghcr that runs on both
      an amd64 machine and the arm64 EC2 host (`docker run … node --version`).
- [ ] Existing suite stays green; CI all-green
- [ ] No secret, hostname, or IP from `.verity/deploy-access.md` appears in any committed file.

## Pipeline test: NO
