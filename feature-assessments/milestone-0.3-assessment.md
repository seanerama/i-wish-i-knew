# Assessment: milestone 0.3 backlog (Mode A, second pass)

- **Date:** 2026-09-06
- **Input:** `docs/architecture.md` phases 3-4, reviewer carry-forwards from PRs #7-#12, the `v0.0.1` ship pre-flight scan, and the deferred list in `initial-backlog-assessment.md`.
- **Decision:** ACCEPT as six stages (7-12) under milestone 0.3. Phase 5 (second-domain fixture, replication, operator-exclusion ADR) is deferred to a third pass after stage 9 has produced a real cooperative answer.

## Claim / reality check against `main` at b3a5d3a

| Claim | Reality | Consequence |
|---|---|---|
| `POST /v1/evidence/query` is a stub | `modules/aggregate/index.ts` (166 lines) always returns `insufficient_evidence` with `no_cooperative_evidence` | Stage 9 replaces it behind a flag |
| Worker has job kinds | `worker.ts` counts queued jobs and exits; `jobs` table exists with no producers | Stage 7 adds the loop and first kinds |
| Runs carry sharing/withdrawal state | `evidence.runs` has no `sharing_policy`, `withdrawn_at`, `node_id`, or context index columns; plaintext columns are `protocol_ref`, digests, `execution_status` | Stage 7 adds withdrawal columns; stage 8 adds the index projection; both additive with backfill jobs |
| Receipts can go `stale` | `evidence.receipts` has `evidence_revision` but nothing compares it to later revisions | Stage 7 adds `revision_log` and the comparison |
| Three MCP tools are `not_yet_available` | `tools.ts` line 130 | Stages 7 and 10 wire them |
| Envelope entities `Challenge`, `Outcome`, `Claim`, `Relationship` complete | Stage 1 left them as minimal stubs | Stage 10 completes them additively |
| Image is clean | Trivy: 1 CRITICAL + 12 HIGH, all in npm CLI and Alpine OpenSSL, none in app deps | Stage 12 |
| Re-invite exists | Admin endpoint `409`s on an existing name; console copy promises re-invite | Stage 11 |

## Ordering and parallelism

7 → 8 → 9 → 10 is the spine (each needs the previous one's tables). 11 and 12
are independent and can run in parallel with 7. Nothing here needs a new
contract: every endpoint is already listed in `member-api` or is an additive
operator endpoint; envelope changes complete stubbed entities and add typed
`AnswerReceipt.result` sections, both additive.

## Contract safety

- `AnswerReceipt.result` is currently `unknown`-typed sections; stage 9 types them. Additive.
- `Challenge`/`Outcome`/`Claim`/`Relationship` gain fields; additive (they had only ids).
- No frozen contract is edited. Wire details will be recorded additively after each review, as in 0.1/0.2.

## Deferred, with trigger

| Item | Plan when |
|---|---|
| Second-domain fixture (`network-failover` via NetClaw or `ci-pipeline/duration`) | after stage 9 |
| Independent replication and decision-quality evaluation (phase 5) | after stage 10 |
| Operator-exclusion decision ADR (ADR-0002 gate) | before first real-member release |
| Process-level harness sandbox (replace in-process guard) | Security Auditor after `verity security init` |
| Nightly `pg_dump` backup job and restore drill | SRE stage after staging is live |
| Hosted MCP for query-only tools | not before console has real users |
