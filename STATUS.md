# I Wish I Knew — Status & Handoff

> Runtime/ops truth (framework-spec §4.6). Owned by the **Release/Deploy Operator**,
> updated on every deploy. Records secret **locations** only — never values.

**As of:** not yet deployed

## TL;DR

Scaffolded by Verity. Release pipeline and host artifacts exist (stage 4);
nothing deployed yet.

## Environments

Targets per ADR-0004. The Operator (`/verity:ship`) replaces every
"not deployed" with the real tag, URL, and date on the first deploy and keeps
the row current afterwards; host addresses and credentials are never written
here (only secret *locations*).

| Environment | Method | Image tag | URL | Last deploy | Runbook |
|---|---|---|---|---|---|
| staging | `nsaf-dev-server` — systemd unit `deploy/i-wish-i-knew.service`, per-app PostgreSQL on the host, tailnet-only | not deployed | not deployed | — | [`deploy/staging/README.md`](deploy/staging/README.md) |
| production | `coolify` on `ec2-primary` — Docker-image application, Coolify PostgreSQL resource, Cloudflare-proxied domain | not deployed | not deployed | — | [`deploy/production/README.md`](deploy/production/README.md) |

## Live deployment

- (none)

## Images

- prefix: `ghcr.io/seanerama/i-wish-i-knew`
- built by `.github/workflows/release.yml` on every `v*` tag: `linux/amd64` +
  `linux/arm64`, tagged `<tag>` and `sha-<short>`
- (no releases yet)

## Secrets

- (none configured) — when set, list NAMES + on-disk LOCATIONS only, never values.
  Names each environment needs: `deploy/staging/env.example` (staging),
  `deploy/production/README.md` §1.3 (production).

## Coordination notes

- Deploy access (host, credential locations) is shared out-of-band; see
  `.verity/deploy-access.README.md`.
