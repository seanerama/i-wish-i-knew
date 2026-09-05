# Stage 0 — walking skeleton

The thinnest end-to-end slice that compiles, runs, passes one real test, goes
green in CI, and deploys to staging. It blocks every feature stage. It proves
the spine **runner → intake → store → receipt** against the frozen contracts,
nothing more.

## Scope

**packages/contracts**
- TypeBox definitions for `ProtocolVersion`, `Run`, `ContextField`, `AnswerReceipt` (the rest of the envelope may be stubs marked `TODO(stage)` but the four above are complete).
- `npm run contracts:build` emits `contracts/schema/v1/*.json`; `contracts:check` fails on drift.
- One conformance fixture: a valid `Run` for `inference-api/latency@1`, plus one invalid (missing required context) that must fail.

**packs/inference-api**
- `latency@1` protocol only. `protocol.json`, `context.schema.json`, `result.schema.json`, `claims.json`.
- Harness: N sequential requests to an OpenAI-compatible chat endpoint, records TTFT and total ms per attempt, writes `attempts.jsonl` and `result.json` per the `runner-pack` contract.
- `fixtures/stub-server`: in-repo HTTP server emulating the endpoint with configurable delay and error rate.

**packages/runner**
- `iwik run --protocol inference-api/latency@1 --target http://127.0.0.1:PORT --context concurrency=1 …` executes the harness under the egress guard, writes the run to the vault, derives accounting from `attempts.jsonl`.
- `iwik preview` and `iwik submit` call the service. Node token and Ed25519 key read from `~/.iwik/` (or `IWIK_HOME`).
- No MCP server yet (Phase 2 stage).

**packages/service**
- Fastify app: `GET /healthz`, `GET /readyz`, `GET /v1/protocols/{ref}`, `POST /v1/contributions/preview`, `POST /v1/runs` (idempotent, preview-bound, signature-verified), `GET /v1/receipts/{id}`.
- PostgreSQL migrations creating `identity.organizations`, `identity.nodes`, `identity.tokens`, `evidence.runs` (ciphertext body + plaintext index columns), `evidence.receipts`.
- Envelope encryption module: per-org data key wrapped by `IWIK_KEK` from env.
- One seeded organization and node token for local/staging use (from env, not committed).
- Console page `/` rendering service name, evidence revision, count of accepted runs for the caller's org. Server-rendered, no client build.
- Worker entrypoint that runs and exits cleanly (no jobs yet).

**Delivery**
- `Dockerfile` (multi-stage, `node:22-alpine`, multi-arch), `docker-compose.yml` with a `db` service for local development.
- `.github/workflows/ci.yml` gates job runs `.verity/gates.json` with a Postgres service container.
- `deploy/i-wish-i-knew.service` systemd unit for staging (ADR-0004).

## The one real test

`packages/service/test/spine.test.ts`, run by `npm test` with `DATABASE_URL` set:

1. Start the stub server with 20 ms delay and a 10 % error rate.
2. Start the service against a fresh database with migrations applied.
3. Invoke the runner programmatically against the stub with `planned = 20`.
4. Assert the vault holds a `Run` whose `accounting.attempted = 20` and whose
   `failed` count equals the stub's recorded errors; `execution_status = succeeded`.
5. `preview` then `submit`; assert `201` with a receipt id.
6. `submit` the identical body again; assert `200` and the same receipt id.
7. Alter one context value and resubmit with the old `preview_id`; assert `409 preview_mismatch`.
8. Inject a fake API key into a context value; assert `422` whose details name the path and rule but not the value.

## Gates (`.verity/gates.json`)

`npm ci` → `contracts:check` → `typecheck` → `lint` → `test` → `docker build`.
All six must exit 0 locally and in CI. No gate may be skipped or marked
`continue-on-error`.

## Done when

- CI is green on `main` with the gates above.
- The image is published to `ghcr.io/seanerama/i-wish-i-knew:0.0.1`.
- Staging on the NSAF dev server answers `/readyz` and renders `/`.
- `STATUS.md` records the staging deployment.

## Hand-off

`/verity:plan` decomposes Stage 0 into work-items and creates the Phase 2–5
backlog from `docs/architecture.md`. Every later stage extends the contracts
additively or proposes a new one through the Planner.
