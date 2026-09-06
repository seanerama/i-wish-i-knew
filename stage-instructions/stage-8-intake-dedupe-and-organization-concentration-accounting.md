# Stage 8: Intake dedupe and organization concentration accounting

- **Type:** feature
- **Depends on:** 7
- **Milestone:** 0.3 protected cooperative answers
- **Work-item:** https://github.com/seanerama/i-wish-i-knew/issues/14
- **Design refs:** brief §7 "Independent evidence" and §6 "Enforce organization-level cohort thresholds and contribution caps"; ADR-0002 thresholds; ADR-0003 analysis unit

## Objectives

Make contributor counts honest before anything is aggregated: repeated uploads
of the same measurement, and many nodes or agents inside one organization, must
not inflate independence. Give stage 9 the plaintext index it needs to form a
cohort without decrypting bodies.

## What to build

**packages/service**
- Migration (additive): `evidence.runs` gains `measurement_digest text` (SHA-256 over the JCS of the harness `result` + `attempts` summary + `target.label_digest` + `protocol_digest`, computed at intake), `node_id text`, `index_context jsonb` (only the protocol's `required_context` keys, plaintext, with `origin`), `is_fixture boolean`; index on `(protocol_ref, measurement_digest)` and a GIN index on `index_context`. Backfill for existing rows via a worker job that decrypts and projects (`index_backfill`), so the column is never trusted until the job has run (`index_version` column).
- Intake: a submission whose `measurement_digest` already exists **for the same org** is accepted with `receipt.kind = intake`, `status = duplicate`, `duplicate_of` set (own org only), and does not increment contributor counts; across orgs the same digest is stored but flagged `shared_source_suspect = true` (brief: deduplicate shared source material) for stage 9 to weigh.
- Concentration accounting: `evidence.contributions(protocol_ref, org_ref, runs_accepted, runs_withdrawn, last_received)` maintained in the intake/withdrawal transactions; a `cohort_preview` internal function returning distinct-org count, run count, and max org share for a `(protocol_ref, filters)` tuple, used by stage 9 and exposed read-only to operators at `GET /v1/admin/cohorts?protocol_ref=` (operator token) as ranges only.
- Free-text limit and secret rescan now also cover `index_context` values.
- ADR-0002 rule "fixture runs are never releasable": `is_fixture = true` rows are excluded from `contributions`.

## Interface contracts

- **Exposes:** duplicate receipts; `GET /v1/admin/cohorts` (additive, operator scope); the plaintext index projection.
- **Consumes:** stage 7 worker and revision log; `evidence-envelope` v1 (`Run.context`, `required_context`).

## Testing requirements

- Same run body submitted twice from two nodes of one org → second is `duplicate`, contributions count 1.
- Same measurement from two orgs → both stored, `shared_source_suspect` on both, contributions count 2.
- Ten runs from org A and one from org B → `cohort_preview` reports orgs 2, max share 0.91.
- Fixture runs never appear in contributions.
- Backfill job projects `index_context` for pre-existing rows and sets `index_version`.
- `index_context` never contains a key outside `required_context` (test with an extra key).

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag (default OFF) for this net-new feature: `IWIK_FEATURE_DEDUPE` (off → intake behaves as today; index projection still written so the backfill is not needed later)
- [ ] UI-smoke "observably-works" check authored for any user-facing surface: `smoke/cohorts.md` (operator view)
- [ ] Additive migration only (no destructive schema change)
- [ ] Existing suite stays green; CI all-green

## Pipeline test: NO
