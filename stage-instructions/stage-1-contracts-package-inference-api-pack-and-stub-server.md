# Stage 1: Contracts package, inference-api pack, and stub server

- **Type:** chore
- **Depends on:** none
- **Milestone:** 0.1 walking skeleton
- **Work-item:** https://github.com/seanerama/i-wish-i-knew/issues/1
- **Design refs:** ADR-0001, ADR-0003, ADR-0005; `contracts/evidence-envelope.md`, `contracts/runner-pack.md`; `docs/walking-skeleton.md`

## Objectives

Turn the frozen contracts into code and make CI green for the first time.
After this stage the repo has a real build, a real test, and committed JSON
Schema artifacts that every later stage validates against. No service, no
runner, no database yet.

## What to build

**Monorepo root**
- `package.json` with npm workspaces `packages/*`; scripts `contracts:build`, `contracts:check`, `typecheck`, `lint`, `test` that fan out to workspaces. Exact pinned versions, `package-lock.json` committed, `engines.node = 22.x`, `.nvmrc` already present.
- ESLint + Prettier config (flat config), `tsconfig.base.json` (strict, `NodeNext`).
- `Dockerfile` placeholder is **not** in scope (stage 2), but the `image` gate must pass: add a minimal `Dockerfile` that copies the repo and runs `node --version`, with a `TODO(stage-2)` comment. It is replaced in stage 2.

**packages/contracts**
- TypeBox definitions under `src/v1/`: `ProtocolVersion`, `Run`, `ContextProfile`, `ContextField`, `ArtifactCommitment`, `AnswerReceipt` complete per `contracts/evidence-envelope.md`. `Investigation`, `Claim`, `Relationship`, `Challenge`, `Outcome` as minimal but valid schemas with required identifiers only, each marked `// TODO(stage): complete in <phase>`.
- `src/canonical.ts`: JCS (RFC 8785) canonicalization used for digests and signatures.
- `src/validate.ts`: Ajv 2020 instance preloaded with all v1 schemas; `validate(entity, value)` returns `{ ok, errors: [{ path, rule }] }` and never echoes values.
- `bin/build.ts` writes `contracts/schema/v1/<Entity>.schema.json`; `contracts:check` rebuilds to a temp dir and diffs against the committed files, exit 1 on drift.
- `contracts/fixtures/v1/`: `run.valid.json`, `run.missing-required-context.json`, `run.bad-accounting.json` (sums do not reconcile), `receipt.valid.json`.

**packs/inference-api**
- Layout exactly per `contracts/runner-pack.md`: `pack.json`, `protocols/latency/{protocol.json,context.schema.json,result.schema.json,claims.json}`.
- `protocol.json` for `inference-api/latency@1`: `kind = controlled`, required context `model.requested`, `model.reported`, `concurrency`, `retry_policy`, `cache_disabled`, `client_region`; permitted claims `latency_distribution`, `error_rate`.
- `harness/index.js`: reads `IWIK_INPUT`, performs `planned` sequential chat completions against `target.url` (OpenAI-compatible `/v1/chat/completions`, streaming to measure TTFT), writes `attempts.jsonl`, `result.json` (per-attempt TTFT ms, total ms, status, error class, tokens; summary percentiles p50/p90/p95/p99), `context.json` with `model.reported` as `origin = measured`. Exit codes per contract. Respects `IWIK_ALLOWED_HOSTS` by refusing any URL whose host is not listed. No dependencies beyond Node built-ins.
- `fixtures/stub-server/index.js`: HTTP server emulating `/v1/chat/completions` with streaming; env or CLI flags for `delay_ms`, `error_rate`, `model_name`; records every request and exposes `GET /__stub/stats` for tests.
- `packs/README.md` describing pack digest computation (`scripts/pack-digest.js` implements it).

## Interface contracts

- **Exposes:** `@iwik/contracts` (types, schemas, `validate`, `canonicalize`), the committed `contracts/schema/v1/*.json`, the `inference-api` pack, the stub server.
- **Consumes:** nothing. This stage is the root of the dependency graph.

## Testing requirements

- `packages/contracts/test/fixtures.test.ts`: every `*.valid.json` passes, every other fixture fails with the expected `path` and `rule`.
- `packages/contracts/test/canonical.test.ts`: JCS vectors from RFC 8785 examples.
- `packs/inference-api/test/harness.test.js`: start the stub with `delay_ms = 20`, `error_rate = 0.1`, seeded RNG; run the harness with `planned = 20`; assert `attempts.jsonl` has 20 lines, failed count equals the stub's error count, `result.json` validates against `result.schema.json`, exit code 0. A second case with an unreachable target must exit 3 with no attempts written.
- Egress guard test: host not in `IWIK_ALLOWED_HOSTS` → exit 2, zero requests hit the stub.

## Acceptance conditions

- [ ] Clear exit-state defined (what "done" means here): all six gates in `.verity/gates.json` exit 0 locally via `verity gates run` and in CI on the PR; `contracts/schema/v1/` is committed and `contracts:check` is clean.
- [ ] Existing suite stays green; CI all-green
- [ ] No runtime dependency added that is not pinned to an exact version.
- [ ] The harness and stub have zero third-party dependencies.

## Pipeline test: NO
