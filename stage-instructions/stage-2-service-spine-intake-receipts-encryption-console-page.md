# Stage 2: Service spine: intake, receipts, encryption, console page

- **Type:** feature
- **Depends on:** 1
- **Milestone:** 0.1 walking skeleton
- **Work-item:** https://github.com/seanerama/i-wish-i-knew/issues/2
- **Design refs:** ADR-0001, ADR-0002, ADR-0006; `contracts/member-api.md`, `contracts/evidence-envelope.md`; `docs/walking-skeleton.md`

## Objectives

The cloud half of the spine. A signed `Run` submitted over `member-api` is
validated, sanitized, encrypted per organization, stored idempotently, and
answered with a receipt. A member can open the console and see that it landed.
Identity is seeded from environment for now (stage 6 replaces that).

## What to build

**packages/service** (Fastify 5, `pg`, `node-pg-migrate`, `@fastify/view` + Eta, Ajv via `@iwik/contracts`)

- `src/app.ts` builds the Fastify instance; `src/server.ts` starts it; `src/worker.ts` connects, logs `worker idle`, and exits 0 (job table exists, no jobs yet).
- Config from env only: `DATABASE_URL`, `IWIK_KEK` (32-byte base64 or hex), `IWIK_SEED_ORG`, `IWIK_SEED_NODE_TOKEN`, `IWIK_SEED_NODE_PUBKEY`, `PORT`, `IWIK_FEATURE_INTAKE` (kill-switch, default `off` in production, `on` in test/dev).
- Migrations (`migrations/`), additive only:
  - `identity.organizations(org_id, name, created_at)`, `identity.nodes(node_id, org_id, pubkey, created_at, revoked_at)`, `identity.tokens(token_hash, node_id, scopes[], created_at, revoked_at)`, `identity.org_refs(org_id, org_ref)`.
  - `evidence.runs(run_id pk, org_ref, protocol_ref, protocol_digest, harness_digest, execution_status, content_digest, body_ciphertext bytea, key_id, evidence_revision, received_at)`, `evidence.receipts(receipt_id pk, org_ref, kind, status, payload jsonb, evidence_revision, issued_at)`, `evidence.previews(preview_id pk, org_ref, content_digest, expires_at)`, `evidence.revision(singleton counter)`, `jobs(job_id, kind, idempotency_key unique, state, attempts, run_after, payload)`.
- `src/modules/identity/`: bearer auth hook; token lookup by SHA-256 hash; scope check returning `403 scope_required`.
- `src/modules/crypto/`: per-org data key generated on first use, wrapped with `IWIK_KEK` (AES-256-GCM), stored in `identity.org_keys`; `seal(org_ref, bytes)` / `open`.
- `src/modules/intake/`: `POST /v1/contributions/preview` → validate against `Run` schema, secret-pattern rescan (AWS keys, bearer-looking strings, private-key headers, URLs with credentials, plus a configurable regex list), free-text length limit on every string field, target label must be a digest; returns `preview_id`, `content_digest`, sanitization report. `POST /v1/runs` → requires `preview_id` whose `content_digest` matches the recomputed one (`409 preview_mismatch`), verifies Ed25519 signature over the JCS body against the node's pubkey (`401 bad_signature`), idempotent on `run_id` (`200` same receipt / `409 run_conflict`), accounting must reconcile (`422`), `target.kind = fixture` is accepted but stored with `sharing_policy = private` regardless of what was sent. Increments evidence revision. Issues a receipt of `kind = intake`.
- `GET /v1/receipts/{id}`, `GET /v1/runs/{run_id}` (own org only, decrypts), `GET /v1/protocols` and `GET /v1/protocols/{ref}` served from `packs/` loaded at boot with computed digests.
- `GET /healthz`, `GET /readyz` (db ping + migrations current), `GET /v1/openapi.json`.
- `src/modules/console/`: `GET /` server-rendered page: product name, the ADR-0002 trust-boundary statement, evidence revision, and for an authenticated node (token via a simple session cookie form for now) the count of its organization's accepted runs and its last receipt id.
- Error envelope per contract; a test asserts no submitted string value ever appears in an error body.
- Structured JSON logs (pino) with `org_ref` only, never bodies.
- `Dockerfile` (multi-stage, `node:22-alpine`, `CMD ["node","packages/service/dist/server.js"]`), `docker-compose.yml` with `db` (postgres:16-alpine) and `app`.

## Interface contracts

- **Exposes:** `member-api` v1 endpoints listed above; the image `ghcr.io/seanerama/i-wish-i-knew`.
- **Consumes:** `@iwik/contracts` schemas and canonicalization (stage 1); `packs/` for the registry.

## Testing requirements

- `packages/service/test/spine.test.ts` (needs `DATABASE_URL`): fresh schema via migrations, seeded org/node; using `contracts/fixtures/v1/run.valid.json` signed with a test key: preview → submit `201` → resubmit `200` same receipt → altered body with old preview `409 preview_mismatch` → altered `run_id` with bad signature `401` → injected AWS key in a context value `422` with `rule = secret_pattern` and no value echoed → unreconciled accounting `422`.
- Kill-switch test: `IWIK_FEATURE_INTAKE=off` → `POST /v1/runs` returns `503 feature_disabled`, `/healthz` still `200`.
- Crypto test: sealed body is not readable without the KEK; wrong KEK fails to open.
- Console test: `GET /` renders the trust statement and the run count.
- **UI-smoke asset** for the Operator: `smoke/console.md` with the steps "open `/`, see the trust-boundary statement and an evidence revision number; `GET /readyz` returns `{ok:true}`".

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag (default OFF) for this net-new feature: `IWIK_FEATURE_INTAKE`
- [ ] UI-smoke "observably-works" check authored for any user-facing surface: `smoke/console.md`
- [ ] Additive migration only (no destructive schema change)
- [ ] Existing suite stays green; CI all-green
- [ ] `docker compose up` on a clean machine reaches `/readyz` green.
- [ ] No endpoint returns another organization's `run_id`, `node_id`, or `org_ref` (covered by test).

## Pipeline test: NO
