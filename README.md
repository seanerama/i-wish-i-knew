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
- `packages/runner` — the `iwik` CLI and `@iwik/runner` API: local policy, vault, harness executor with egress guard, plan/run/report, preview and submit, and the `iwik mcp` agent adapter (`SKILL.md`)
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
`NODE_ENV=production`, `on` otherwise), `IWIK_FEATURE_WITHDRAWAL` (stage 7,
default `off` everywhere; see "Withdrawal" below), `IWIK_FEATURE_DEDUPE` (stage 8,
default `off` everywhere; see "Dedupe" below), `IWIK_FEATURE_COOPERATIVE_QUERY`
(stage 9, default `off` everywhere; see `smoke/query.md`),
`IWIK_FEATURE_CHALLENGE` (stage 10, default `off` everywhere; see "Challenge
and outcome ledger" below), and the optional seed identity
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
node packages/runner/bin/iwik.cjs init --service http://localhost:3000 --token-file ./node-token   # node id via GET /v1/whoami
node packages/runner/bin/iwik.cjs plan --protocol inference-api/latency@1 --target http://127.0.0.1:8089 --target-kind fixture \
  --question "how fast is the stub?" --context model.requested=stub-model --context concurrency=1 \
  --context cache_disabled=true --context client_region=local       # prints a plan id; never executes
node packages/runner/bin/iwik.cjs policy set allow_execution true
node packages/runner/bin/iwik.cjs policy allow-target 127.0.0.1:8089
node packages/runner/bin/iwik.cjs run --plan <plan_id>              # or run --protocol ... --target ... directly
node packages/runner/bin/iwik.cjs report <run_id>                   # "Local evidence only — not corroborated by the cooperative"
node packages/runner/bin/iwik.cjs preview <run_id> && node packages/runner/bin/iwik.cjs submit <run_id>
node packages/runner/bin/iwik.cjs withdraw <run_id...> --reason member_request   # needs IWIK_FEATURE_WITHDRAWAL=on (smoke/withdrawal.md)
IWIK_MCP_ENABLED=on node packages/runner/bin/iwik.cjs mcp           # stdio MCP server for agents (smoke/mcp.md)
```

## Withdrawal and the worker (stage 7)

Behind `IWIK_FEATURE_WITHDRAWAL` (default **off**: `POST /v1/withdrawals`
and the console form answer `404 feature_disabled`, and the MCP tool
`withdraw_contribution` answers `feature_disabled` with a next step):

- `POST /v1/withdrawals` (scope `publish`) with `{ "run_ids": [...],
  "reason_code": "member_request" | "data_error" | "policy_change" }`
  withdraws the caller's own runs. Every id must belong to the caller's
  organization; any foreign or unknown id makes the whole request
  `404 not_found` and nothing is withdrawn (the response never says which).
  The withdrawal is one evidence-revision increment, serialized with intake on
  the same lock; the runs are marked `withdrawn_at` / `withdrawn_revision` in
  that transaction and the same set (any order) returns the original
  `withdrawal_id` with `200`. `iwik withdraw <run_id...> --reason <code>` and
  the `/org` page (list of own runs, checkbox form with a confirmation) are the
  member surfaces.
- **Stale receipts** (ADR-0002 §6): `evidence.revision_log` records which
  protocol each revision touched (intake and withdrawal). `GET /v1/receipts/{id}`
  reads a query receipt as `status: "stale"` when a later revision touched its
  protocol; nothing else in the receipt changes and nothing says what was
  removed. Intake receipts never go stale. Delivered answers cannot be recalled.
- **Worker.** `node packages/service/dist/worker.js` runs the job loop:
  every `IWIK_WORKER_INTERVAL_MS` (default `5000`) it claims jobs with
  `SELECT ... FOR UPDATE SKIP LOCKED` (several workers share one queue), retries
  a failing job 5 times with exponential backoff, then leaves it `state =
  failed` with `last_error`; `locked_at` / `locked_by` show who holds a running
  job, and a lock older than 10 minutes is re-queued. `--once` does one pass
  and exits (tests, cron); SIGTERM finishes the job in flight and exits 0. Job
  kinds: `reap_previews` (expired previews, scheduled hourly by the worker
  itself), `withdrawal_apply` (re-asserts the marks and evicts revision-keyed
  `evidence.cache` rows, empty until stage 9), and `sharing_backfill` (sets
  `evidence.runs.sharing_policy` from the decrypted body for rows that predate
  the stage 7 migration; the column is trustworthy only where
  `backfill_version` is set, and intake sets both on insert).

## Dedupe and concentration accounting (stage 8)

Contributor counts are made honest before anything is aggregated (brief §7,
ADR-0002 thresholds, ADR-0003 "one contributor = one organization"):

- **Plaintext index projection.** Next to the ciphertext, intake writes
  `evidence.runs.measurement_digest`, `node_id`, `index_context`, `is_fixture`
  and `index_version`. `index_context` holds only the protocol's
  `required_context` keys as `{ value, origin }`; a key outside that list is
  never projected, and the projected values go through the same secret rescan
  and length limit as the body. `measurement_digest` is
  `sha256:` + SHA-256 over the JCS form of
  `{ protocol_digest, target_label_digest: target.label_digest, result, attempts_summary: accounting }`,
  so a re-upload of the same measurement (new `run_id`, another node, other
  timestamps or context) collides. Rows that predate the stage 8 migration are
  projected by the worker job `index_backfill` (self-scheduled while any row
  has `index_version IS NULL`); a row is never used to form or count a cohort
  before that. Stage 9 forms cohorts from this projection without decrypting.
- **Contributions ledger.** `evidence.contributions(protocol_ref, org_ref,
  runs_accepted, runs_withdrawn, last_received)` is maintained inside the
  intake and withdrawal transactions and rebuilt by `index_backfill`. Fixture
  runs (`target.kind = fixture`, never releasable) and same-organization
  duplicates never touch it.
- **Behind `IWIK_FEATURE_DEDUPE`** (default **off**): the same
  `measurement_digest` from the same organization is accepted as an intake
  receipt with `status: "duplicate"` and `duplicate_of: <your earlier run_id>`;
  it is stored, not counted, and is not an evidence revision. The same digest
  from another organization is stored and counted for both, and both rows are
  flagged `shared_source_suspect` for stage 9 to weigh (a shared source is one
  contributor, not two). With the flag off intake behaves exactly as before,
  but the projection and the ledger are still written, so turning the flag on
  later needs no backfill.
- **Operator view.** `GET /v1/admin/cohorts?protocol_ref=<ref>&filter.<key>=<value>`
  (operator token; `404 feature_disabled` while the flag is off) answers with
  ranges only: `orgs` (`<3`, `3-5`, `6-10`, `11+`), `runs` (`<5`, `5-10`,
  `11-50`, `51+`) and `max_org_share` (`<=50%` or `>50%`, the ADR-0002 cap).
  Filter keys must be `required_context` keys; values parse as JSON scalars
  (`1`, `true`) or strings. Exact counts exist only in the internal
  `cohortPreview` used by stage 9. Smoke check: `smoke/cohorts.md`.

## Challenge and outcome ledger (stage 10)

Behind `IWIK_FEATURE_CHALLENGE` (default **off**: `POST /v1/challenges`,
`GET /v1/challenges/{id}`, `POST /v1/outcomes`, and the operator resolve
endpoint answer `404 feature_disabled` before authentication, the operator
console pages `/admin/login` and `/admin/challenges` are `404`, and the MCP
tools `challenge_finding`, `register_prediction`, `report_outcome` answer
`feature_disabled` with a next step). Brief R9 and R10.

- **Claims.** Every finding a cooperative answer releases becomes a `Claim`
  row (`evidence.claims`: origin `measured`, corroboration `unreplicated`,
  status `supported`, its cohort as bands, never a run id), written inside
  the stage 9 release transaction whether or not the flag is on, and the
  finding carries its `claim_id` (additive on `AnswerReceipt.result.findings`).
- **Challenges.** `POST /v1/challenges` (scope `publish`) targets one of the
  caller's released query receipts or a claim released on one, with `grounds`
  from `method | context_mismatch | data_error | replication_failed |
  affiliation` and a `statement` in the pack vocabulary (claim, metric,
  statistic, context key, direction, one of the caller's own runs as
  `replication_run_id`) plus the one bounded free-text `note` (500 chars,
  rescanned for secret patterns, seen by the operator only). Foreign or
  unknown targets are `404` as a whole; five per organization per rolling
  day, then `429` with `Retry-After` (filing many objections suppresses
  nothing: a challenge changes no evidence until the operator resolves it).
  A challenge is visible to its filer (`GET /v1/challenges/{id}`) and the
  operator only.
- **Resolution** (`POST /v1/admin/challenges/{id}/resolve`, operator token,
  or the `/admin/challenges` console after an operator sign-in with the same
  token, CSRF-protected and rate limited per address): `upheld` records a
  `contradicts` relationship and marks the targeted claims `contradicted` /
  `disputed`; `rejected` records `narrows` and leaves them; `superseded`
  records `supersedes` and marks them `rejected`. The challenge's own
  assertion is stored as a counter-claim (origin `reported`). Every
  resolution bumps the evidence revision (`revision_log` kind `challenge`),
  so query receipts of that protocol issued earlier read `stale`; `409
  challenge_resolved` on a second attempt. Audit rows carry ids only.
- **Predictions and outcomes** (`POST /v1/outcomes`, two steps). First
  `{ prediction }`: the receipt relied on, the target (claim, metric,
  statistic, threshold), a horizon date, an optional probability, and the
  evaluation rule, stored with `registered_at`. Later
  `{ prediction_id, observed }`: `result` (`met | not_met | indeterminate`)
  and `environment_changed`, stored in separate columns so a moved
  environment is never folded into "prediction wrong". Exactly one
  observation per prediction (`409 outcome_exists`); the stored prediction
  can never be altered (`409 prediction_immutable` when a body restates it,
  `409 target_mismatch` when a restated target or receipt differs, and a
  database trigger refuses updates outright).
- **Runner.** `iwik challenge <receipt_id|claim:<id>> --grounds <g> [--note ...]`,
  `iwik predict --receipt <id> --target <claim[.metric[.statistic]]> --horizon <date> --rule <r>`,
  `iwik outcome <prediction_id> --result <r> [--environment-changed]`;
  `SKILL.md` tells the agent to register a prediction BEFORE acting. Smoke
  check: `smoke/challenge.md`.

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
