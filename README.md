# I Wish I Knew

A confidential evidence cooperative for measurable technical systems: agents ask what has worked in comparable circumstances, run the missing test, and contribute safely.

> Scaffolded by [Verity](https://github.com/seanerama/verity-framework) — prompt to production, proven.

## Status

See [`STATUS.md`](STATUS.md) for live runtime state (deployed version, environments).

## Project identity

- **slug:** `i-wish-i-knew`
- **images:** `ghcr.io/seanerama/i-wish-i-knew`

## Architecture

- [`docs/architecture.md`](docs/architecture.md) — the map: topology, modules, phase plan, what is deferred
- [`docs/walking-skeleton.md`](docs/walking-skeleton.md) — Stage 0 definition and its one real test
- [`docs/adr/`](docs/adr/) — decision records (stack, trust boundary, first domain, deployment, contracts, agent access)
- [`contracts/`](contracts/) — frozen v1 interface contracts, additive-only
- [`i-wish-i-knew-architect-brief.md`](i-wish-i-knew-architect-brief.md) — the product brief this design answers

**Pilot trust boundary (ADR-0002):** evidence is stored sanitized and encrypted per organization, but service operators are inside the trust boundary during the pilot. Operator exclusion is a gate before the first real-member release, not a current guarantee.

## Layout

- `packages/contracts` — frozen v1 envelope as TypeBox + committed JSON Schema, JCS canonicalization, validation, pack digests
- `packages/service` — Fastify service: `member-api` intake, receipts, envelope encryption, protocol registry, console, worker
- `packs/` — domain packs (data + harness); first: `inference-api`
- `smoke/` — UI-smoke checks the Operator runs after a deploy

## Run locally

Requires Node 22 (`.nvmrc`) and Docker.

```sh
npm ci
docker compose up -d db                         # PostgreSQL 16 (IWIK_DB_PORT=55432 if 5432 is taken)
export DATABASE_URL=postgres://iwik:iwik@localhost:5432/iwik
export IWIK_KEK=dev-only-not-a-secret            # any value outside production; 64 hex chars in production
npm run migrate                                  # apply packages/service/migrations
npm test                                         # contracts, service spine (real Postgres), packs
npm run dev                                      # http://localhost:3000  (console at /, API at /v1)
```

Service configuration is environment-only: `DATABASE_URL`, `IWIK_KEK`, `PORT`,
`IWIK_FEATURE_INTAKE` (kill-switch for preview/submit; default `off` when
`NODE_ENV=production`, `on` otherwise), and the optional seed identity
`IWIK_SEED_ORG`, `IWIK_SEED_NODE_TOKEN`, `IWIK_SEED_NODE_PUBKEY` (base64 raw
Ed25519 public key), `IWIK_SEED_NODE_ID`. Extra secret patterns for intake:
`IWIK_SECRET_PATTERNS` (JSON array of regex sources).

The whole stack on a clean machine: `IWIK_KEK=$(openssl rand -hex 32) docker compose up --build`,
then `curl localhost:3000/readyz`. Gates (`.verity/gates.json`): `node .verity/run-gates.cjs`.
