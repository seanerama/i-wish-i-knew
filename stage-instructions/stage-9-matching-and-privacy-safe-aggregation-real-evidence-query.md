# Stage 9: Matching and privacy-safe aggregation: real evidence query

- **Type:** feature
- **Depends on:** 7, 8
- **Milestone:** 0.3 protected cooperative answers
- **Work-item:** https://github.com/seanerama/i-wish-i-knew/issues/15
- **Design refs:** brief §3 steps 2-3, §4 "Evidence, matching, and explanation", §5 aggregate answer contents, §7 "Fair statistics"; ADR-0002 thresholds and fixed cohort releases; ADR-0003 matching rules and analysis unit; `contracts/evidence-envelope.md` (`AnswerReceipt`, count-range vocabulary); `contracts/member-api.md` (`POST /v1/evidence/query`)

## Objectives

Replace the stub with the real thing: hard compatibility, soft ranking,
versioned calculation, privacy thresholds, differencing defence, and a
released or honestly suppressed `AnswerReceipt`. This is the product's first
cooperative answer.

## What to build

**packages/service** (`modules/matching`, `modules/aggregate`)
- Matching: candidates = accepted, non-withdrawn, non-fixture runs with the same `protocol_ref` major, `harness_digest` in the protocol's `compatibility.harness_digests`, and every `context_filters` key equal in `index_context`. Soft ranking on remaining `required_context` keys (exact match > provider_reported > unknown) produces an ordered candidate list; ranking never admits an incompatible run.
- Cohort policy (ADR-0002, `policy_version = "2026-09-p1"`): release requires ≥3 distinct orgs, ≥5 runs, max org share ≤ 50 %; `shared_source_suspect` runs count as one org across the pair; counts released as ranges. Suppression reasons from the fixed vocabulary (`min_orgs`, `min_runs`, `concentration`, `differencing`, `no_cooperative_evidence`).
- Differencing defence: persist every released cohort (`evidence.cohort_releases(query_digest, protocol_ref, filters, run_ids_hash, org_count, revision)`); a new query whose cohort differs from any prior release **by fewer than 3 orgs** is suppressed with `differencing`. `as_of_revision` pins a cohort for reproducibility.
- Calculation (`calculation_version = "latency-v1"`): per permitted claim, within-condition distributions (p50/p90/p95/p99, n), error rate, contributor concentration, missing-data accounting (attempted/succeeded/failed/excluded/unobserved sums), freshness (newest/oldest `received_at` as dates), contradictions (flag when the interquartile ranges of two org-level distributions do not overlap; never propose a cause), limitations (unknown context counts). Analysis unit is the run; org is the contributor. Implemented as pure functions over decrypted bodies fetched only for the matched cohort, with fixture-backed tests.
- Decrypt-scope rule: the query path decrypts only cohort members, never the whole table, and never logs bodies.
- Cache: `evidence.cache` keyed by `(query_digest, revision)`; withdrawals evict (stage 7 job).
- `POST /v1/evidence/query` returns the real receipt; the requester's own runs are always shown to the requester in a separate `own_evidence` section (allowed by ADR-0002 "Members can inspect their own evidence") even when the cooperative cohort is suppressed.
- Runner `iwik report --cooperative` and MCP `query_evidence` render applicability, ranges, uncertainty, freshness, contradictions, and the suppression explanation.

## Interface contracts

- **Exposes:** real `POST /v1/evidence/query`; `AnswerReceipt.result` sections (typed in `packages/contracts` additively: `findings`, `applicability`, `distributions`, `missingness`, `contradictions`, `uncertainty`, `freshness`, `limitations`, `own_evidence`).
- **Consumes:** stage 8 index and contributions; stage 7 revision log and cache eviction; `evidence-envelope` v1.

## Testing requirements

- Fixture cohort builder (three orgs × N runs against the stub with seeded latencies) drives: released answer with correct ranges; 2 orgs → `min_orgs`; 4 runs → `min_runs`; one org with 60 % → `concentration`; a narrowed re-query removing one org → `differencing`; withdrawal → prior receipt `stale`, re-query recomputed.
- Contradiction test: two orgs with non-overlapping IQRs → contradiction flagged, no cause text.
- Receipt privacy test: no `run_id`, `node_id`, `org_ref`, or exact count below 11 in any released receipt; own evidence contains only the caller's ids.
- Calculation pure-function tests with hand-computed percentiles.
- MCP `query_evidence` end-to-end.

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag (default OFF) for this net-new feature: `IWIK_FEATURE_COOPERATIVE_QUERY` (off → stub behaviour from stage 5 continues)
- [ ] UI-smoke "observably-works" check authored for any user-facing surface: `smoke/query.md` (via `iwik report --cooperative` and the console receipt page)
- [ ] Additive migration only (no destructive schema change)
- [ ] Existing suite stays green; CI all-green
- [ ] Brief minimum demonstrations 3 (contradiction visible, no invented cause) and 5 (private records absent from other-member answers) are covered by named tests.

## Pipeline test: NO
