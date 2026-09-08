# Assessment: repeatable cooperative investigation on staging

- **Date:** 2026-09-08
- **Request:** user accepted planning the recommended repeatable staging
  investigation, following the discussion of project direction.
- **Verified source:** `main` at `190af1932a860e9800c29c34a448a916ca5c9616`.
- **Decision:** SPLIT into two dependency-ordered chores, stages 13 and 14,
  under milestone **0.4 repeatable cooperative investigation**.
- **Milestone:** https://github.com/seanerama/i-wish-i-knew/milestone/4
- **Stage 13:** [instruction](../stage-instructions/stage-13-staging-readiness-for-a-cooperative-investigation.md), [work item #25](https://github.com/seanerama/i-wish-i-knew/issues/25).
- **Stage 14:** [instruction](../stage-instructions/stage-14-repeatable-cooperative-investigation-on-staging.md), [work item #26](https://github.com/seanerama/i-wish-i-knew/issues/26).

## Claim / reality check

| Assumption | Evidence and reality | Planning consequence |
| --- | --- | --- |
| Existing backlog is unfinished | `verity stage list` lists 1–12; GitHub has no open issues and milestones 0.1–0.3 are closed. Latest main CI run is successful. | Build on the implemented stack; do not recreate earlier features. |
| Staging is known to be ready | `STATUS.md` still says not deployed, while `.verity/smoke.json` specifies a staging URL. Read-only `/readyz` and `/healthz` requests on 2026-09-08 both returned connection refused. This does not establish host contents or deployment history. | Stage 13 reconciles runtime truth and records actual verification. |
| A tag proves the latest stack is deployed | GitHub lists `v0.0.1`, but a tag alone proves neither a successful release scan nor the live image. | Verify the successful release artifact and running digests at execution time. |
| Deployment includes the worker | `deploy/i-wish-i-knew.service` starts `server.js`; `server.ts`/`app.ts` do not start a worker. `worker.ts` implements a separate loop and `--once`, but no worker unit is committed. | Stage 13 adds the worker unit and deploys/rolls back both processes at the same digest. |
| Current deployment failure handling covers pre-start errors | `deploy/staging/deploy.sh` changes the environment's image reference before migration; `set -e` can exit before its later rollback block. | Test and fix migration/startup failure handling as part of paired deployment. |
| Staging environment examples cover the shipped features | `env.example` documents intake and seed identity; `config.ts` also requires configuration for enrollment, dedupe, query, challenge, withdrawal, and worker tuning. Feature flags default off. | Document an explicit demo profile without changing product defaults. |
| The complete learning loop is exercised by one existing demo | `spine.test.ts` exercises the runner-to-intake fixture path; `cooperative.test.ts` exercises modeled cohorts; `challenge.test.ts` exercises predictions/outcomes and real CLI/MCP calls. Smoke instructions are separate. | Stage 14 joins the existing surfaces, reusing regression coverage. |
| Fixture measurements can produce a cooperative release | ADR-0003 requires stub runs to carry `target.kind=fixture`; intake/matching exclude them. `smoke/query.md` currently instructs labeling the stub as `service`, contrary to that rule. | Correct the smoke instructions. Use genuine controlled-service measurements for live release; synthetic test records stay in disposable test databases. |
| Three demo organizations demonstrate independent replication | `cohort` policy counts organization identities and merges suspect shared sources; it does not establish that three operator-created organizations are independent participants. | Label them as demo identities and defer independent-member claims. |
| Six contributions guarantee a released answer | Policy requires ≥3 qualifying orgs, ≥5 qualifying runs, ≤50% concentration, plus differencing defense. Dedupe and history can prevent release. | Assert eligibility, bound retries, and design repeat/resume behavior around actual release history. |
| A full Investigation API can anchor the scenario | `member-api.md` lists investigation endpoints, but `app.ts` registers no investigation module; `packages/contracts/src/v1/stubs.ts` still has a minimal Investigation. Local plans and the prediction ledger exist. | Capture the question locally and use the existing prediction route. Do not silently scope in another product feature. |
| Multiple protocols or domains are ready | `packs/inference-api/pack.json` lists only `latency@1`; aggregation identifies itself as `latency-v1`. | Limit this milestone to inference latency/error measurements. |
| A successful outcome-recording test establishes predictive usefulness | Existing challenge tests prove storage ordering/immutability. No pre-registered comparison of public/local/cooperative decisions is supplied by those tests. | Stage 14 reports execution evidence and friction, not recommendation quality. |

## Scope and ordering

Stage 13 depends on stages 4, 6, 7, 8, 9, 10, and 12. It supplies the verified
API/worker runtime and correct deployment procedure. Stage 14 depends on 13 and
supplies the repeatable investigation, negative-path coverage, live evidence,
and observations to inform the next intake. Both are chores because they
operationalize and validate existing product behavior. Existing flags and UI
smoke requirements still apply.

The milestone ends when both stages meet their acceptance conditions. It is a
thin first step toward the architecture's phase 5, not a promise to complete
pilot validation or establish decision quality within this milestone.

## Contract and architecture safety

The four frozen contracts remain intact. These stages consume existing
surfaces and introduce no public interface. A worker systemd unit implements
the API/worker topology already accepted in ADR-0001 and the hosting method in
ADR-0004. Local execution, scopes, signing, preview approval, privacy thresholds,
fixture exclusion, revision semantics, and operator access remain as specified.
No new contract or architectural ADR is warranted for this batch.

The operator-access gate in ADR-0002 remains unresolved for the first real-member
release. This plan uses operator-controlled demo identities, non-sensitive inputs,
and an authorized controlled endpoint; it does not select a new trust model or
accept real-member data. Any future architecture change returns to the Planner
and its ADR confirmation gate.

## Execution prerequisites and evidence ownership

- Stage 13 requires host access, an appropriate successful release, and the
  existing deploy workflow. Read-only probes during intake do not authorize or
  attest to a deployment. The Operator owns updates to `STATUS.md`.
- Stage 14 requires an explicitly supplied compatible non-fixture service
  endpoint, accurate price inputs, and an execution budget. No provider, endpoint,
  credentials, or cost approval is inferred from this planning request.
- Specs and this assessment hold intent. Live reports attach to work items;
  they must distinguish tests, live measurements, and incomplete checks.
- If the prerequisites cannot be supplied, report incomplete execution. Do not
  replace measurements with fabricated data or relax contracts to finish a demo.

## Deferred work and trigger

| Work | Trigger for another intake |
| --- | --- |
| Pre-registered public-information vs local vs cooperative decision evaluation | Stage 14 yields a repeatable cycle and measured operating cost; define scoring, held-out outcomes, sample needs, and non-improvement criteria before collecting evaluation results. |
| Supported independent-member pilot and operator-access ADR | A concrete participant/question match exists; resolve ADR-0002 before collecting real-member evidence. |
| Tool-use protocol or second-domain extension fixture | First evaluation identifies its value; recheck schemas and calculation semantics against the selected protocol. |
| Backup/restore drill and stronger harness isolation | Operational/security intake once staging is verified; required scope reassessed before real-member operation. |
| Investigation persistence or broader UX features | Stage 14 records a concrete user need; plan separately instead of expanding this demonstration. |

## Builder handoff

Build stage 13 first, then stage 14, using their instruction files and the four
existing contracts. Follow the normal review and Release/Deploy Operator flow
for live validation. Creating this plan does not start implementation or deploy.
