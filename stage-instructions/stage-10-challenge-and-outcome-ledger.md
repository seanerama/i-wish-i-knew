# Stage 10: Challenge and outcome ledger

- **Type:** feature
- **Depends on:** 9
- **Milestone:** 0.3 protected cooperative answers
- **Work-item:** https://github.com/seanerama/i-wish-i-knew/issues/16
- **Design refs:** brief R9, R10, §3 steps 6-7, §7 "Outcome learning" and "Challenge handling"; `contracts/evidence-envelope.md` (`Challenge`, `Outcome`, `Claim`, `Relationship`); `contracts/member-api.md` (`POST /v1/challenges`, `POST /v1/outcomes`); `contracts/agent-tools.md` (`challenge_finding`, `report_outcome`)

## Objectives

Close the learning loop: a member can challenge a released finding with
structured grounds, and can register a prediction before an outcome is known
and report the outcome later. Both are recorded, never silently applied, and
neither can suppress evidence by volume.

## What to build

**packages/contracts** (additive): complete `Challenge`, `Outcome`, `Claim`, `Relationship` schemas that stage 1 left as minimal stubs, including `Challenge.grounds` enum (`method`, `context_mismatch`, `data_error`, `replication_failed`, `affiliation`), `Outcome.prediction` (target, horizon, probability optional, evaluation_rule) and `Outcome.observed` (recorded separately, later).
**packages/service** (`modules/challenge`)
- Migrations (additive): `evidence.challenges`, `evidence.predictions`, `evidence.outcomes`, `evidence.relationships`.
- `POST /v1/challenges` (scope `publish`): targets a `receipt_id` the caller holds or a `claim_id`; structured grounds; rate-limited per org (5/day) so filing many objections cannot suppress evidence; status lifecycle `open → acknowledged → resolved(upheld|rejected|superseded)`; resolution is an operator action (`POST /v1/admin/challenges/{id}/resolve`, operator token) that records a `Relationship` (`contradicts`/`narrows`/`supersedes`) and bumps the revision so affected receipts go `stale`.
- `POST /v1/outcomes` in two steps: `{ prediction }` before the outcome (stores target, horizon, evaluation rule, receipt it was based on, timestamp) → `{ prediction_id, observed }` after; the observed report cannot alter the stored prediction (test); a changed-environment flag is recorded separately from "prediction wrong".
- Operator view `/admin/challenges` (console) listing open challenges with grounds only.
- Runner/MCP: `challenge_finding` and `report_outcome` switch from `not_yet_available` to real calls; `iwik challenge`, `iwik predict`, `iwik outcome` commands.
- Feature flag `IWIK_FEATURE_CHALLENGE` (default off).

## Interface contracts

- **Exposes:** challenges, predictions, outcomes endpoints; operator resolve endpoint (additive); completed envelope entities.
- **Consumes:** stage 9 receipts and revision log; `agent-tools` v1.

## Testing requirements

- Challenge lifecycle with resolution → relationship recorded → prior receipt `stale`.
- 6th challenge in a day → `429`; earlier five unaffected.
- Prediction stored before outcome; outcome report with a different target → `409`; changed-environment flag stored separately.
- Privacy: challenge threads never expose another org's run ids; error messages carry codes only.
- MCP tools end-to-end; `smoke/challenge.md`.

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag (default OFF) for this net-new feature: `IWIK_FEATURE_CHALLENGE`
- [ ] UI-smoke "observably-works" check authored for any user-facing surface: `smoke/challenge.md`
- [ ] Additive migration only (no destructive schema change)
- [ ] Existing suite stays green; CI all-green

## Pipeline test: NO
