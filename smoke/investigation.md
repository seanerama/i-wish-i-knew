# Repeatable cooperative investigation (stage 14)

Builder tooling and fixture/synthetic regression do **not** complete live
acceptance. The Operator must attach two independently executed cycle reports
to [work item 26](https://github.com/seanerama/i-wish-i-knew/issues/26). The
operator-controlled non-fixture endpoint, access, prices and budget are not yet
supplied: both live cycles are **incomplete**. No paid provider is assumed.
Runtime deployment evidence and `STATUS.md` remain Operator-owned.

This procedure exercises frozen member-api, evidence-envelope, runner-pack and
agent-tools v1 through the installed runner, existing HTTP routes and console.
It never calls the unimplemented `/v1/investigations` or inserts staging data
into PostgreSQL. The three throwaway organizations simulate members; they are
not independent real-member replication. One prediction cycle establishes no
held-out decision quality, usefulness, or service-level target.

## Preparation and prerequisites

Use Node 22 and the reviewed checkout. Run `npm ci && npm run build`; the driver
imports the installed `i-wish-i-knew` workspace package and invokes its built CLI
and MCP server. The runner must have access to this checkout's packs directory.
The protocol is `inference-api/latency@1`; the registry and local pack/harness
digests must agree. They are recorded by preflight, as are scoped node identities.

The stage 13 source is `.verity/evidence/stage-13-staging-2026-09-08.json`: final
`restored-demo` API and worker image is v0.1.1 at the digest in the example,
source commit `ca5b9e3880898e14c14abee24061887411cb7079`. Verify the **actual**
running API and worker still match that exact reference, the public origin,
and six enabled flags: intake, enrollment, dedupe, cooperative query,
challenge and withdrawal. Follow [staging readiness](staging-readiness.md) for
Operator host inspection and restart pacing. Capture that inspection in a
restricted artifact and write `runtime.json` with `checked: true`, current
`observed_at`, `image`, `deployed_commit`, `service_url` and descriptive `notes`.
The driver cannot inspect deployment images through member APIs; this is an
explicit Operator observation, not something inferred from `/healthz`.

Use isolated demo-only staging data. Inventory prior demo contributions before
starting. Never reset the database, delete cohort release history, change
privacy thresholds, or relabel context to obtain a release. Normal cleanup
below withdraws **all** this cycle's submitted runs. A fresh cycle uses new
organizations, keys, scoped tokens, homes and journal; accurate model/region
context remains the same. Historic cohorts still participate in differencing
checks; if unrelated remaining evidence prevents the expected empty or released
answer, record incomplete and reconcile authorized demo data through ordinary
withdrawals. Never withdraw another member's evidence.

The inference service must be operator-controlled, compatible with streaming
OpenAI-shaped chat completions and this harness's fixed non-sensitive prompt
set, with accurate requested/reported model and region, concurrency 1, caching
disabled and no retries. Inspect `packs/inference-api/harness/prompts.json`.
The driver keeps threshold and horizon in the local scenario, outside Run
measurements. Choose an actual question, workload and a supported target:
`ttft_ms`/`total_ms` with `p50|p90|p95|p99`, or `error_rate` without a statistic;
choose `below|above`, a numeric threshold, and future UTC `YYYY-MM-DD` horizon.
This driver evaluates `own_measurement` only. Tail spreads with six runs do not
support a tail claim. The question can include both latency and error budgets;
only the explicitly selected metric is the prediction's success criterion.

The in-repo stub **always** uses `target.kind = fixture` and remains private,
even if cooperative sharing was requested. It cannot satisfy live release.
CI executes that fixture and separately uses clearly synthetic service-shaped
records through existing test helpers in a disposable database. Never copy
those records into staging or modify measured observations to force dedupe,
agreement, contradiction or success.

Prepare a private parent directory outside the checkout (no secrets in git):

```sh
umask 077
export INVESTIGATION_BASE="$(mktemp -d /tmp/iwik-stage14.XXXXXXXX)"
export INVESTIGATION_DIR="$INVESTIGATION_BASE/cycle-1"
cp smoke/investigation.example.json "$INVESTIGATION_BASE/config.json"
```

Edit that private copy. Fill every `null`/`REPLACE` with actual approved inputs;
remove `api_key_env` when no target credential is required, otherwise put only
the environment variable **name** there. Load its value securely on the runner
node. `commit` is `git rev-parse HEAD` for the reviewed tooling; `deployed_commit`
is the verified stage 13 source. Set three absolute home paths and
`runtime_evidence_file`. Set actual per-million prompt and completion token USD
prices, including explicit zero only for a genuinely unbilled service. Set
`max_runs` from 7 through 100 inclusive, `max_requests` (at least 7 × planned),
`max_usd`, and `max_elapsed_ms` (including human approval pauses). At least ten
successful attempts are needed for each latency run. Twelve planned requests
is a starting workload, not a guaranteed qualifying run.

The 100-run cap applies to the entire cycle across all three organizations,
including additional attempts and the follow-up. It keeps every organization
within the existing 100-ID withdrawal request and 100-entry own-evidence
limits. Preflight rejects a larger budget before measurement or submission;
use fresh demo identities for a separately authorized cycle, not a larger cap.

Each execution reserves its entire request count and estimated cost before
starting. Estimate = planned × (64 × prompt price + max_tokens × completion
price) / 1,000,000. The runner also enforces its per-plan local budget. The
driver requires enough wall time for (planned + 1) × per-request timeout + 10 seconds
before launch. Reservations remain charged after errors or interruption;
there is no automatic retry or refund. Reporting and cleanup remain possible
after the measurement deadline. Estimates are not measured invoices; record
actual invoices, if available, as restricted artifacts and describe that basis
separately in review. Do not extrapolate throughput or service-level objectives.

## Enroll and record the empty starting point

Follow [enrollment](enrollment.md) **in the browser** to create three fresh
throwaway organizations using operator invitations, accept the agreement,
register one distinct runner signing key per organization and issue each a
node token scoped `query`, `submit`, `publish`. For each configured home:

```sh
node packages/runner/dist/cli.js --home /absolute/home-A init --service https://actual-staging-origin
# Register the printed public key in that organization's console; save its token to a 0600 file.
node packages/runner/dist/cli.js --home /absolute/home-A init --service https://actual-staging-origin --token-file /private/token-A
node packages/runner/dist/cli.js --home /absolute/home-A policy set allow_execution true
node packages/runner/dist/cli.js --home /absolute/home-A policy allow-target actual-inference-host:port
node packages/runner/dist/cli.js --home /absolute/home-A policy set budget_per_plan_usd APPROVED_PER_PLAN_USD
```

Repeat for B and C. The driver never enables local policy itself. Keep console
passwords and tokens out of screenshots, shell history, and shareable artifacts.
Use exact service/target URLs from the configuration; placeholders above must be
replaced. All commands run on the operator-controlled runner host, not in CI.

```sh
node scripts/investigation.cjs init "$INVESTIGATION_DIR" "$INVESTIGATION_BASE/config.json"
node scripts/investigation.cjs step "$INVESTIGATION_DIR" preflight
```

Expected: `Prepared private scenario; preflight and live execution incomplete.`
then `PASS preflight; restricted result saved in journal.json.` Missing endpoint,
identity, policy, flags, image evidence or budget exits 1. Nothing executes in
preflight. Inspect `journal.json` privately for exact results/errors. The config
is snapshotted and hash-bound: changing it after initialization is rejected.
If preflight fails before any work, fix the source config and initialize a new
unused directory; do not erase a journal containing executed/submitted work.

Manual checkpoints take a JSON proof file, never a bare `true`. It must contain
`checked: true`, actual `observed_at`, nonempty `notes`, and `artifacts`: absolute
paths to nonempty restricted screenshots, HAR, saved HTTP responses or worker
logs. The driver records artifact locations and hashes. A proof file is an
Operator attestation; its contents must reflect an actual observed check.
Missing proof leaves the step incomplete. Example **shape**, not evidence:

```json
{
  "checked": true,
  "observed_at": "ACTUAL_RFC3339_UTC_TIME",
  "notes": "ACTUAL observations, comparisons, and their limitations",
  "artifacts": ["/absolute/private/actual-recording"]
}
```

```sh
node scripts/investigation.cjs step "$INVESTIGATION_DIR" enrollment /private/enrollment-proof.json
node scripts/investigation.cjs step "$INVESTIGATION_DIR" initial
```

Expect local `report_empty` (the existing CLI has no runs yet) and an empty
`insufficient_evidence` cooperative answer. A local measurement report appears
immediately after each run below. Enrollment proof identifies the three browser
sessions, distinct keys/homes and scope selection, restricted to the Operator.

## Measure, inspect, preview, approve

For A1 execute each command separately, reviewing the indicated private output
before continuing. The driver uses `iwik plan`, `run --plan`, local `report`,
`preview` and `submit` implementations without bypassing any policy:

```sh
node scripts/investigation.cjs step "$INVESTIGATION_DIR" plan-A1
node scripts/investigation.cjs step "$INVESTIGATION_DIR" run-A1
node scripts/investigation.cjs step "$INVESTIGATION_DIR" local-A1
node scripts/investigation.cjs step "$INVESTIGATION_DIR" preview-A1
# Inspect private/plan-A1.json, local-A1.json, preview-A1.json and the runner vault.
# Approval is explicit and belongs to the contributing member:
node scripts/investigation.cjs step "$INVESTIGATION_DIR" approve-A1 --approve
```

Each successful checkpoint prints `PASS <name>` and writes private JSON plus
`report.md`. That means the checkpoint ran, not that the run qualifies or that
the whole scenario passed. Inspect execution status, failed/excluded/unobserved
accounting, context provenance, claimed minima, digest matching, sanitized body,
sharing policy and submission receipt `accepted|duplicate`. A duplicate never
counts; do not assume timing jitter guarantees distinct runs. Review the local
report's `eligible_runs` and subsequently the query's own-evidence reasons.

Repeat those five steps for A2, B1 and B2; then:

```sh
node scripts/investigation.cjs step "$INVESTIGATION_DIR" two-orgs
```

Require two genuine qualifying runs from each of A and B and suppression with
`min_orgs`. Repeat the five steps for C1 and C2, then:

```sh
node scripts/investigation.cjs step "$INVESTIGATION_DIR" release
node scripts/investigation.cjs step "$INVESTIGATION_DIR" replay
node scripts/investigation.cjs step "$INVESTIGATION_DIR" surfaces
```

If a run is duplicate/ineligible, retain its artifacts and use the next unused
slot for that member (A3, etc.) only within the already authorized budget. Do
not rerun a completed slot or change any measured value/context. Stop once two
qualifying runs exist per organization; otherwise extra qualifying runs break
the intended six-run scenario. On exhausted budget report incomplete and clean
up. `release` requires six distinct run IDs and each member's actual two
`in_cohort` records, `released`, bands `3-5` organizations / `5-10` runs, policy
`2026-09-p1`, calculation `latency-v1`, and unsupported tail claims. It also scans
released sections for run identifiers and foreign member identifiers.

`replay` sends one identical stored signed body again and requires HTTP 200 and
the original receipt, not an additional contribution. `surfaces` uses the real
CLI `receipt <id>` and stdio MCP `get_receipt` to read **the original** receipt;
it records its existing Markdown renderer output. CLI `report --cooperative`
and MCP `query_evidence` issue **new receipts** for the same cohort. Their IDs
(and finding claim IDs) are intentionally different; compare sections and
versions, not new receipt IDs. The tool compares MCP sections after removing
per-receipt claim IDs. No browser response is mocked by this driver.

Sign in as A and open `/receipts/<original receipt_id>` from the private release
artifact; confirm the same original ID/revision and applicability, missingness,
uncertainty, freshness, limitations, actual agreement/contradiction, and own
run IDs confined to own evidence. Compare with CLI/MCP private artifacts. Sign
in separately as B and open that same URL: require HTTP 404 `Receipt not found`.
Foreign identifiers must appear neither in released sections nor errors. Save
actual screenshots/responses and record:

```sh
node scripts/investigation.cjs step "$INVESTIGATION_DIR" console-released /private/console-released-proof.json
```

## Prediction before the follow-up measurement

```sh
node scripts/investigation.cjs step "$INVESTIGATION_DIR" prediction
node scripts/investigation.cjs step "$INVESTIGATION_DIR" plan-followup
node scripts/investigation.cjs step "$INVESTIGATION_DIR" run-followup
node scripts/investigation.cjs step "$INVESTIGATION_DIR" local-followup
node scripts/investigation.cjs step "$INVESTIGATION_DIR" outcome unchanged
# Use "changed" instead if the environment actually changed.
node scripts/investigation.cjs step "$INVESTIGATION_DIR" second-outcome
```

The prediction references the original receipt and the predeclared target,
horizon and `own_measurement` evaluation rule. The new local run must start
strictly after server registration. The outcome derives the observed value from
the runner's local claim metric; invalid/insufficient samples or observations
after the horizon yield `indeterminate`. A measured failure can yield `not_met`;
no `met` option exists. `environment_changed` is a separate explicit input.
The returned original prediction is checked unchanged, and the second write
must fail HTTP 409 `outcome_exists`. Follow-up remains local/private and is not
submitted: its local run ID and measured value are retained in the execution
journal; no nonexistent service run is sent as `evaluation_run_id`.

## Withdrawal, worker evidence, flag off and restoration

```sh
node scripts/investigation.cjs step "$INVESTIGATION_DIR" withdraw
node scripts/investigation.cjs step "$INVESTIGATION_DIR" stale
node scripts/investigation.cjs step "$INVESTIGATION_DIR" pinned
```

A's two qualifying contributions (and any additional submitted attempts owned
by A) are withdrawn with the existing publish route. The old receipt must read
`stale`, fresh and pinned queries must be suppressed below three organizations,
and own withdrawn runs must remain excluded even when pinning the original
revision. Re-read the old receipt in the CLI and browser; the console must show
`Status: stale`. Record actual console evidence:

```sh
node scripts/investigation.cjs step "$INVESTIGATION_DIR" console-stale /private/console-stale-proof.json
```

Immediate evidence-revision checking makes receipts stale before any worker
cache eviction. Separately observe the real worker's `withdrawal_apply` job,
not a maintenance probe. The Operator may do a restricted **read-only** lookup
of `public.jobs` by `kind='withdrawal_apply'` and
`payload->>'withdrawal_id' = '<journal withdrawal_id>'`, then correlate that
job's ID with the worker journal's `job done` log and persisted `state='done'`.
Never insert or modify staging data to make this check pass. The worker proof
JSON additionally requires `job_kind: "withdrawal_apply"`, matching
`withdrawal_id`, `effective_revision`, `job_id`, and `state: "done"`; include
both the restricted lookup and worker log in `artifacts`.

```sh
node scripts/investigation.cjs step "$INVESTIGATION_DIR" worker /private/worker-proof.json
```

The Operator temporarily sets only `IWIK_FEATURE_COOPERATIVE_QUERY=off` using
the established staging configuration/restart procedure. Pace restarts as in
stage 13 (rapid restarts can exhaust systemd's start limit). Record prior and
temporary flags privately, then:

```sh
node scripts/investigation.cjs step "$INVESTIGATION_DIR" flag-off
```

Expect the stage 5 `insufficient_evidence` stub with `no_cooperative_evidence`
over the same retained evidence; nothing cooperative is released. Restore the
six declared demo flags and verified API/worker image; confirm the console
states and readiness. Save actual restored-state evidence, then:

```sh
node scripts/investigation.cjs step "$INVESTIGATION_DIR" restored /private/restored-proof.json
node scripts/investigation.cjs step "$INVESTIGATION_DIR" cleanup
node scripts/investigation.cjs step "$INVESTIGATION_DIR" inventory /private/inventory-proof.json
node scripts/investigation.cjs friction "$INVESTIGATION_DIR" receipt-navigation delay /private/friction.json
node scripts/investigation.cjs report "$INVESTIGATION_DIR"
```

Cleanup checks own-run existence for pending/failed submission intents and
withdraws accepted runs even if their submission response was lost. It then
withdraws every recorded submitted run for A/B/C, including private
fixture attempts during local testing and duplicates. It is safe to invoke
after any incomplete step; repeated cleanup recomputes the recorded sets.
Remaining organizations, nodes, tokens, local keys/homes, local follow-up,
receipts, prediction/outcome and withdrawal/release audit history must be
inventoried in the private proof. Record token revocation/retention decisions
and artifact retention locations. New submissions invalidate prior inventory
completion; collect inventory again after final cleanup.

A cycle cannot be marked complete until a friction observation is recorded.
Use category `none` only with an explicit actual no-friction observation in the
private notes; an empty log does not establish that. Other friction categories
are `enrollment`, `approval`, `context`, `dedupe`,
`receipt-navigation`, `prediction`, `withdrawal`, `restart-pacing`, `budget`,
`other`; impacts are `minor`, `delay`, `blocked`. The final argument is a private JSON file with nonempty `notes` describing
the concrete observation and impact; the journal retains that detail without
copying it into the shareable report. Broader features
or product fixes return to the Planner, not this chore.

## Resume and failure recovery

The 0700 scenario directory holds `scenario.json`, atomically written 0600
`journal.json`, `private/<step>.json`, and the sanitized Markdown report.
Each action records pending intent before a mutation. Earlier submission
intent survives failed retries, and error history remains in separate private
failure artifacts even after a later success. An exclusive `.lock`
rejects concurrent writers. After a crash, verify the PID is dead and that no
runner child still executes before removing only that stale lock. Keep the
journal and all reservations. Run `report` to see pending/incomplete steps.
Successful steps reuse their recorded identifiers; `cleanup` deliberately
rechecks all recorded submissions. Do not call raw `iwik run` outside the driver
when relying on its total execution budget.

- An incomplete manual proof can be supplied again with actual artifacts.
- Failed assertions/errors exit 1. Read the private error and real receipt;
  suppression, duplicate submissions and inconclusive measurements are honest
  outcomes, never reasons to change source observations.
- An interrupted submission can retry `approve-<slot> --approve` using the
  stored signed run and preview; remote idempotency prevents another row.
  An accepted identical re-submit returns 200. Never regenerate the run.
- An expired preview requires a new preview of the **same** local run and
  explicit reapproval; use `step ... preview-<slot> --refresh` and inspect it.
  Preserve the old private artifact in the restricted bundle first.
- Interrupted `run`, prediction registration or outcome writes are ambiguous
  and are **not retried**. Inspect the recorded plan/vault and console ledger
  to reconcile. For a run, `plans/<plan_id>.json` and vault metadata identify
  any completed measurement. For a prediction/outcome, preserve the server's
  original response/console record; there is no member API list/read endpoint
  for recovering an unknown prediction ID. Never create another prediction
  merely because a response was lost. If exact original completion cannot be
  established, leave that cycle incomplete, retain charged reservations, and
  perform ordinary recorded-run cleanup. Reconciliation requiring a journal
  correction must be reviewed against original restricted artifacts; do not
  set a checkpoint to pass by assumption.
- Expired budgets block new measurements but permit report, withdrawal and
  cleanup. Additional authorization means a separately reviewed fresh cycle,
  not edits that erase the existing reservations.
- After a failure during flag-off, restore staging before ending the run even
  if later assertions cannot pass. Record the actual state in Operator-owned
  `STATUS.md` and the restricted proof. No driver command deploys or restarts.

Only `report.md` is shareable. It uses fixed labels, allowlisted codes, numeric
timings/reservations, commit/image digests and fixed relative links into a
restricted bundle. It excludes question/context/threshold text, endpoints,
credentials, node/run/org/receipt identifiers, raw errors and private records.
Do not upload the directory. Measured/estimated costs are explicitly separated;
no free-form proof text is copied into the shareable report. Link access-controlled
artifacts on the issue separately. Attach cycle 1 and cycle 2 reports; a single
successful cycle still does not fulfill two-cycle acceptance.

## Named deterministic regression set and provenance

Run with **only a disposable local PostgreSQL**; the service helpers reset its
schemas. Never point these commands at an existing or staging database.
`DATABASE_URL` and `IWIK_KEK` must reference disposable test resources.

```sh
npm ci
npm run build
node --import tsx --test --test-concurrency=1 packages/service/test/investigation.test.ts packages/service/test/spine.test.ts packages/service/test/cooperative.test.ts packages/service/test/challenge.test.ts packages/service/test/withdrawal.test.ts
npm run test -w i-wish-i-knew
node .verity/run-gates.cjs
```

The full gate definition includes install, frozen-contract check, typecheck,
lint, every test and Docker image build. CI calls no paid inference service.
Existing CI gate and security/build jobs must be green before merge.

| Named coverage (exact test-name prefix) | File | Provenance / assertion |
| --- | --- | --- |
| `scenario: cycle budget boundary` | `investigation.test.ts` | 100-run budget accepted, 101 rejected before execution/submission; 100 isolated synthetic fixture records remain private, visible as own evidence, and clean up idempotently through the real service. |
| `scenario: incomplete live preflight` | `investigation.test.ts` | Real local service; missing prerequisites and CLI failure exit nonzero, no public canary leakage. |
| `scenario: real runner fixture` | `investigation.test.ts` | Actual plan/run/report/preview/approve to loopback stub; fixture private, resume/idempotency. |
| `scenario: interrupted execution/prediction/outcome` | `investigation.test.ts` | Private pending-intent/lock regression; no second write or lost reservation. |
| `scenario: accepted submission with lost response` | `investigation.test.ts` | Real commit then simulated transport loss, idempotent resume, cleanup invalidation, expired-budget cleanup. |
| `scenario: synthetic six-run release` | `investigation.test.ts` | Synthetic service-shaped helper intake, actual CLI/MCP/console contradiction rendering, immutable prediction, **later actual fixture run** derives outcome, withdrawal and pin. Never live evidence. |
| `walking skeleton: stub -> iwik run` | `spine.test.ts` | Real runner/fixture/intake with signature, secret scan, fixture exclusion and idempotency. |
| `privacy (brief demonstration 5)` | `cooperative.test.ts` | Synthetic real-service receipt; no foreign identifiers or exact small counts. |
| `suppressed: two organizations` | `cooperative.test.ts` | Synthetic min_orgs/min_runs and concentration suppression. |
| `differencing: a narrowed re-query` | `cooperative.test.ts` | Synthetic cohort release history preserved; narrow query suppressed. |
| `contradiction (brief demonstration 3)` | `cooperative.test.ts` | Synthetic non-overlapping organization IQRs; no proposed cause or identifiers. |
| `console: /receipts/<id>` | `cooperative.test.ts` | Real rendered sections and foreign receipt 404. |
| `MCP query_evidence end-to-end over stdio` | `cooperative.test.ts` | Actual MCP transport and CLI over synthetic service evidence. |
| `predictions: registered before the outcome` | `challenge.test.ts` | Immutable prediction, target mismatch, single outcome, environment changed separate. |
| `refusals: foreign or unknown targets` | `challenge.test.ts` | Foreign ledger isolation, no value echo. |
| `withdraw two of three` | `withdrawal.test.ts` | Real service/worker handler, revision staleness, idempotent withdrawal. |
| `withdrawal: the prior receipt reads stale` | `cooperative.test.ts` | Synthetic withdrawal and pinned query exclusion. |
| `cache: keyed by (query_digest, revision)` | `cooperative.test.ts` | Immediate revision correctness independent of asynchronous eviction. |
| `flag off: the stage 5 stub answer` | `cooperative.test.ts` | Off flag computes/releases nothing over same synthetic evidence. |

All test filenames in the table are under `packages/service/test/`. Runner CLI,
MCP, local/cooperative report and ledger projections are also covered by the
existing `packages/runner/test/` suite. Synthetic contradiction rendering is a
separate regression result, not a demand that the live service measurements
disagree. Preserve whichever agreement/contradiction the live receipt actually
reports. Return friction, baseline timings and limitations to the Planner for
a separately scoped pre-registered evaluation and real-member pilot.
