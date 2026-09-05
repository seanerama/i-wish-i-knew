# 0004. Deployment target: staging on NSAF dev server, production on Coolify EC2

- **Status:** Accepted
- **Date:** 2026-09-05

## Context

The operator's global deployment catalog (`verity deployment list`) offers six
active methods: Cloudflare Pages, Cloudflare Workers via Actions, an NSAF dev
server over Tailscale, Coolify on the EC2 web server, the EC2 server directly,
and EAS for mobile. The app (ADR-0001) is a Node service with a PostgreSQL
database and a background worker, deployed as one container image. The product
handles confidential evidence, so a staging environment that is not publicly
reachable is a real asset. Verity's `prod_promote` is `confirm`.

## Decision

| Environment | Method | Notes |
|---|---|---|
| **Staging** | `nsaf-dev-server` | systemd unit from this repo, per-app PostgreSQL on the host, reachable only on the tailnet. A cloudflared route is added only if external agent testing needs it. |
| **Production** | `coolify` on `ec2-primary` | Coolify builds/pulls the `ghcr.io/seanerama/i-wish-i-knew` image, provisions PostgreSQL on the same host, exposes the domain through the Coolify traefik proxy behind a Cloudflare-proxied record. |

- Images are built **multi-arch (linux/amd64 + linux/arm64)** by CI with buildx;
  the EC2 host is Graviton and requires arm64.
- Promotion is by release tag with operator confirmation (`prod_promote: confirm`).
- The Release/Deploy Operator (`/verity:ship`) reads `.verity/deploy-access.md`
  (gitignored; locations only) when it writes `deploy.sh`.
- Backups: nightly `pg_dump` to encrypted object storage with 30-day expiry
  (matches ADR-0002 withdrawal semantics). Restore drill is an SRE stage.

## Alternatives considered

- **Cloudflare Workers + D1.** Rejected: no PostgreSQL, no long-running worker
  process, and the runner's contract (child-process harnesses, local vault)
  has no counterpart on Workers.
- **Cloudflare Pages.** Static sites only. Rejected.
- **Both environments on EC2.** The host has about 3.7 GB RAM and already runs
  several stacks. Keeping staging off the production box preserves headroom.
- **EC2 directly with docker compose.** Viable, but Coolify already provides the
  proxy, image pulls, rollback, and env management on that host.

## Consequences

- Two hosts to keep in step; `deploy.sh` must target both with one image tag.
- Staging has no public URL by default, so live handoff testing (`/verity:verify`)
  runs from a tailnet client.
- If the EC2 host is retired, production moves to whatever replaces Coolify
  there; the image and migrations are host-agnostic.
