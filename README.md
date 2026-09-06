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
- `packages/runner` — the `iwik` CLI and `@iwik/runner` API: local policy, vault, harness executor with egress guard, preview and submit
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
`IWIK_SECRET_PATTERNS` (JSON array of regex sources). `IWIK_TRUST_PROXY`
(integer hop count, default `0`) makes `request.ip` come from `X-Forwarded-For`
when the service runs behind that many reverse proxies (production: `1`).

The whole stack on a clean machine: `IWIK_KEK=$(openssl rand -hex 32) docker compose up --build --wait`,
then `curl localhost:3000/readyz` (`{"ok":true}`); `docker compose down -v` tears it down.
Only the `app` service builds the image; `migrate` runs the same `i-wish-i-knew:local`
image before `app` starts. Gates (`.verity/gates.json`): `node .verity/run-gates.cjs`.

The runner (`packages/runner/README.md`, smoke check in `smoke/runner.md`):

```sh
npm run build:runner
export IWIK_HOME=$(mktemp -d)                    # default ~/.iwik
node packages/runner/bin/iwik.cjs init --service http://localhost:3000 --token-file ./node-token --node-id <ulid>
node packages/runner/bin/iwik.cjs policy set allow_execution true
node packages/runner/bin/iwik.cjs policy allow-target 127.0.0.1:8089
node packages/runner/bin/iwik.cjs run --protocol inference-api/latency@1 --target http://127.0.0.1:8089 --target-kind fixture \
  --context model.requested=stub-model --context concurrency=1 --context cache_disabled=true --context client_region=local
node packages/runner/bin/iwik.cjs preview <run_id> && node packages/runner/bin/iwik.cjs submit <run_id>
```

## Enrollment (pilot)

Stage 6 replaces the env-seeded identity with real enrollment, behind the
kill switch `IWIK_FEATURE_ENROLLMENT` (default **off** in every environment;
when off, `/enroll/*`, `/org*`, `/console/login`, and `POST /v1/admin/organizations`
answer `404` and the seeded node keeps working unchanged).

1. **Operator bootstrap.** Set `IWIK_OPERATOR_TOKEN` (16+ characters; compared
   as a SHA-256 in constant time; it authorizes exactly one endpoint) and
   `IWIK_FEATURE_ENROLLMENT=on`. Optionally `IWIK_PUBLIC_URL=https://host` so
   invite URLs are absolute. Then:

   ```sh
   curl -s -X POST localhost:3000/v1/admin/organizations \
     -H "Authorization: Bearer $IWIK_OPERATOR_TOKEN" -H 'content-type: application/json' \
     -d '{"name":"Acme"}'
   # -> 201 { "org_id": "...", "invite_url": "/enroll/<one-time invite>", "expires_at": "..." }
   ```

   The invite URL is returned once; only its hash is stored (7-day default
   lifetime, `IWIK_INVITE_TTL_MS`).
2. **Enroll** at the invite URL: set the display name, a console password
   (12+ characters, stored as an scrypt hash), and accept the pilot terms,
   the ADR-0002 trust-boundary statement, and the R11 reciprocity clause. The
   agreement is recorded with the terms version and timestamp
   (`identity.agreements`).
3. **`/org`**: register a node by pasting the public key `iwik init` prints
   (base64 raw 32-byte Ed25519 key, or a PEM SPKI block; stored canonically
   as base64), issue tokens with chosen scopes (`query`, `submit`,
   `publish`; shown exactly once, stored as SHA-256 only), revoke tokens
   (`401 unauthorized`) or whole nodes (`401 node_revoked`, and intake refuses
   the node's signatures). Every enroll/register/issue/revoke writes an
   `identity.audit` row of identifiers only.
4. **Console sign-in** (`/console/login`) is organization name + console
   password. Pilot-only shortcut: an operator-set password instead of email
   magic links (`feature-assessments/initial-backlog-assessment.md`). Failed
   attempts are rate limited per organization + client address, in process
   memory: the 6th failure inside a minute answers `429` with `Retry-After`.

Sessions are an HMAC-signed cookie (key derived from the KEK), `HttpOnly`,
`SameSite=Lax`; forms carry a CSRF token. The stage-2 node-token sign-in on
`/` still works (it uses the same cookie, holding only the token hash) and is
the only sign-in while the flag is off. UI smoke: `smoke/enrollment.md`.

## Release and deploy

- `.github/workflows/release.yml` — on a `v*` tag, builds the Dockerfile for
  `linux/amd64` + `linux/arm64` and pushes `ghcr.io/seanerama/i-wish-i-knew:<tag>`
  and `:sha-<short>`; no deploy step. CI's `release-dry-run` job proves the
  multi-arch build on pull requests that touch the image or `deploy/`.
- `deploy/` — the staging systemd unit, the env variable names
  (`deploy/staging/env.example`), and the runbooks the Release/Deploy Operator
  follows: [`deploy/staging/README.md`](deploy/staging/README.md),
  [`deploy/production/README.md`](deploy/production/README.md). Host and
  credential details live outside the repo (`.verity/deploy-access.README.md`).
- `npm test` also runs `deploy/test/unit-file.test.sh` (`systemd-analyze verify`
  on the unit; a visible SKIP where systemd is absent).
