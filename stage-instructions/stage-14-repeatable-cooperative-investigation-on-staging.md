# Stage 14: Repeatable cooperative investigation on staging

- **Type:** chore
- **Depends on:** 13
- **Milestone:** 0.4 repeatable cooperative investigation
- **Work-item:** https://github.com/seanerama/i-wish-i-knew/issues/26
- **Prerequisite work-item:** https://github.com/seanerama/i-wish-i-knew/issues/25
- **Stage instruction:** `stage-instructions/stage-14-repeatable-cooperative-investigation-on-staging.md`
- **Design refs:** brief §3 and §9 demonstrations 1–3, 5, 7–8; ADR-0002, ADR-0003, ADR-0006; `feature-assessments/repeatable-staging-investigation-assessment.md`

## Objectives

Make the existing inference-latency investigation repeatable through member
surfaces on staging: enroll, measure, preview and approve a contribution, query,
register a prediction, observe a later measurement, and withdraw evidence.
Produce a reviewable evidence report and a list of observed user friction.
This establishes operational behavior; predictive usefulness and independent
real-member replication require a later evaluation.

## What to build

**Scenario and execution tooling.** Add `smoke/investigation.md` and a small
repo-local driver under `scripts/` for repeatable preparation, assertions, and
report collection. Supply exact commands, expected outputs, and recovery steps.
Use the installed runner, documented HTTP routes, and member console; never
insert staging evidence directly into the database or substitute mocked API
responses. Keep browser enrollment and contribution approval explicit where
the current product requires them. This is a chore exercising existing surfaces,
not a new user-facing demo API or general workflow engine.

**Preflight and provenance.** Require stage 13's verified image, enabled demo
flags, isolated demo-only staging data, and three throwaway organizations with
distinct signing keys, scoped tokens, and runner homes. These identities simulate
membership and must never be described as independent real-member replication.
For the released-answer path, require an operator-controlled, compatible
non-fixture inference service, non-sensitive inputs, accurate context, explicit
prices, bounded attempts/time/cost, and an allowed local execution policy.
The endpoint and budget are execution prerequisites; do not invent them or
assume a paid provider is authorized. A missing prerequisite is an actionable
incomplete run. CI makes no paid calls.

Runs against `packs/inference-api/fixtures/stub-server` must retain
`target.kind = fixture` and remain non-releasable, as ADR-0003 requires. Correct
the instructions in `smoke/query.md` that label this stub as a service. Tests may
use clearly identified synthetic service-shaped records in disposable test
databases through existing test helpers; those are never staging measurements
or evidence of real-member usefulness.

**The primary live sequence.**

1. Record a specific latency/error-budget question, threshold, workload, and
   protocol/harness digests in the local scenario record. Use existing local
   planning; do not depend on `/v1/investigations`, which is documented but
   unimplemented, or introduce it in this stage. Keep thresholds out of Run
   measurements; later record the prediction through the existing ledger.
2. Enroll three demo organizations through the console, register their nodes,
   and issue query/submit/publish tokens. Initialize separate runner homes and
   show an initial local-only report/empty cooperative answer.
3. Produce two genuine measurements per organization with compatible context.
   Explicitly plan and run, inspect local reports, preview sharing, and approve
   submission for each. With only two qualifying organizations, demonstrate
   suppression. After the third contributes, require a released answer with
   six distinct qualifying runs and count bands. Assert actual eligibility and
   dedupe outcomes; do not assume timing jitter makes every upload distinct or
   modify observations to force release. Additional attempts require remaining
   budget and a bounded limit. Re-submit one identical signed run and verify
   idempotency without an additional contribution.
4. Read the same released receipt in `iwik report --cooperative`, the member
   console, and MCP `query_evidence`/`get_receipt`. Compare applicability,
   missingness, uncertainty, freshness, and own-evidence separation. With six
   runs, retain the existing unsupported-tail-claim limitation. Another
   organization's receipt must be inaccessible; foreign identifiers must not
   appear in released sections or error responses.
5. Register an explicit prediction against that receipt before executing a
   new follow-up run. Use a supported metric/statistic, threshold, horizon,
   and evaluation rule. Derive the observed result from the later local
   measurement rather than selecting `met` for the demonstration. Record
   `environment_changed` separately, preserve the original prediction, and
   verify a second outcome is rejected. Inconclusive measurements must be
   reported honestly. One cycle is not a held-out decision-quality study.
6. Withdraw one organization's two contributed runs. Verify the earlier query
   receipt becomes stale in CLI and console, subsequent queries are suppressed
   below the thresholds, and a pinned query never readmits withdrawn runs.
   Observe the corresponding invalidation job complete through the worker;
   distinguish immediate revision checking from asynchronous cache eviction.
7. Exercise cooperative-query flag-off behavior, then restore the declared
   staging configuration. Record all remaining demo data and local artifact
   locations. Resume uses recorded identifiers, and a fresh run uses fresh
   demo identities. Account for prior cohort releases in repeatability; never
   clear the release history or weaken differencing rules to obtain a pass.

**Negative scenarios.** Assemble a named, deterministic regression set from
the existing cooperative/challenge/withdrawal suites for non-overlapping IQR
contradictions with no proposed cause, concentration and differencing
suppression, fixture exclusion, prediction immutability, foreign-record
isolation, and withdrawal. Add integration coverage only for missing joins
between steps. Show contradiction rendering through the existing receipt
surfaces using isolated synthetic test evidence; report it separately from the
live service sequence. Live reports must faithfully show agreement or
contradiction as actually measured, without falsifying data to force a result.

**Results and repeatability.** The driver emits a private execution journal
for resume and a sanitized Markdown report template containing commit/image,
protocol/calculation/policy versions, timestamps, scenario provenance,
pass/fail/incomplete steps, submission errors, suppression reasons, elapsed
investigation time, runner execution/reporting time, answer latency, and the
estimated cost basis. Distinguish measured costs from estimates and avoid
service-level targets from this tiny workload. Link restricted raw artifacts
by location; exclude secrets, private records, and identifying raw output from
the shareable report. Record confusing steps and their impact as findings.
New features or broader fixes return to the Planner for their own stages.

Run the complete live sequence twice, including normal withdrawal cleanup,
without resetting unrelated data. The Operator records the resulting reports
as evidence attachments/links on the work item; runtime deployment state stays
in `STATUS.md`, owned by the Operator.

## Interface contracts

- **Exposes:** repo-local scenario tooling, a member smoke procedure, and a
  sanitized execution report for the subsequent evaluation-planning decision.
- **Consumes:** `member-api`, `evidence-envelope`, `runner-pack`, and
  `agent-tools`, all frozen v1; `inference-api/latency@1`; stage 13's staging
  deployment; existing CLI, console, policy, and ledger behavior.
- No new cross-component seam, public endpoint, schema, protocol, privacy
  exception, or corroboration transition. No new contract or ADR is needed.
  The execution journal/report is local tooling output, not a product wire API.

## Testing requirements

- Reuse `packages/service/test/spine.test.ts`, `cooperative.test.ts`,
  `challenge.test.ts`, and `withdrawal.test.ts` plus the runner CLI/MCP tests.
  Document named coverage for each negative scenario and label its provenance.
- Add meaningful integration coverage for the scenario driver: incomplete
  preflight cannot pass, failed steps exit nonzero, resume cannot duplicate
  submissions/outcomes, and public reports do not expose credentials or foreign
  identifiers. Exercise the real service and runner with isolated test data.
- Keep CI fixture-only with no paid network execution; distinguish synthetic
  setup from the actual runner-to-fixture path, which must remain private.
- Run `.verity/gates.json` and required CI jobs. The Operator executes
  `smoke/investigation.md` twice on staging and records actual results.

## Acceptance conditions

- [ ] Runnable scenario, exact member instructions, recovery behavior, and
      sanitized report generation are reviewed and covered by relevant checks.
- [ ] Two live runs demonstrate the primary sequence, with actual receipt,
      prediction, outcome, withdrawal, and worker evidence in restricted reports.
- [ ] Fixture exclusion and the named negative scenarios pass; synthetic
      regression results are clearly distinguished from live measurements.
- [ ] Existing flags remain default off, flag-off behavior is checked, and
      `smoke/investigation.md` covers CLI, console, and MCP observable behavior.
- [ ] Reports include measured timings, cost estimates with basis, limitations,
      and observed friction. No independent-replication or usefulness claim is
      inferred from demo organizations or a successful smoke run.
- [ ] Missing endpoint/access/budget or incomplete live verification remains
      explicit outstanding work, never a successful acceptance result.
- [ ] Existing suite stays green; CI all-green

## Handoff

`$verity-build` implements this stage after stage 13. The Operator runs the
live checks. Return observed friction and baseline timings to `$verity-plan`
to scope a later pre-registered decision-quality evaluation and real-member
pilot. Operator-access selection, recruitment, tool-use, and a second domain
remain outside this stage.

## Pipeline test: NO
