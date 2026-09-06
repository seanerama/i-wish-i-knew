# Stage 7: Withdrawal, revision-keyed stale receipts, and the preview-reaping worker job

- **Type:** feature
- **Depends on:** none
- **Milestone:** 0.3 protected cooperative answers
- **Work-item:** https://github.com/seanerama/i-wish-i-knew/issues/13
- **Design refs:** ADR-0002 §6 (withdrawal semantics), brief R9/R8 and §6 "Support policy changes, retention, and withdrawal"; `contracts/member-api.md` (`POST /v1/withdrawals`, `GET /v1/receipts/{id}` status `stale`), `contracts/evidence-envelope.md` (`AnswerReceipt.status`), `contracts/agent-tools.md` (`withdraw_contribution`)

## Objectives

A member can withdraw its own runs; withdrawal takes effect at the next
evidence revision; receipts issued against an earlier revision report `stale`
without revealing what changed. The worker gets its first real job kinds so
later stages have a durable place for recomputation.

## What to build

**packages/service**
- Migration (additive): `evidence.runs` gains `sharing_policy text NOT NULL DEFAULT 'private'` (backfilled from the decrypted body for existing rows by a one-off job, or left `private` and documented), `withdrawn_at timestamptz NULL`, `withdrawn_revision bigint NULL`; `evidence.withdrawals(withdrawal_id pk, org_ref, run_ids text[], reason_code, requested_at, effective_revision)`; `jobs` gains `last_error text NULL`, `locked_at`, `locked_by`.
- `POST /v1/withdrawals` (scope `publish`): body `{ run_ids: [...], reason_code }` (fixed vocabulary: `member_request`, `data_error`, `policy_change`); every run must belong to the caller's org (`404` for any that does not, without saying which); idempotent on the set; increments the evidence revision inside the same `FOR UPDATE` transaction the intake uses; returns `{ withdrawal_id, effective_revision }`.
- Receipt staleness: `GET /v1/receipts/{id}` computes `status = stale` when the receipt's `evidence_revision` is older than the latest revision that affected its `protocol_ref` (track `evidence.revision_log(revision, protocol_ref, kind)`); the response never lists removed runs. Intake receipts do not go stale.
- Worker: a real job loop in `worker.ts` with `SELECT … FOR UPDATE SKIP LOCKED`, bounded retries (5), exponential backoff, idempotency by `idempotency_key`, observable failure state (`state = failed`, `last_error`), graceful `SIGTERM`. Job kinds: `reap_previews` (delete expired `evidence.previews`), `withdrawal_apply` (marks runs withdrawn, evicts any revision-keyed cache rows — introduce `evidence.cache(key, revision, payload)` now, empty until stage 9). A `IWIK_WORKER_INTERVAL_MS` loop with `--once` flag for tests and cron.
- Console `/org`: list own runs (id, protocol, status, received, withdrawn) and a "withdraw" form with confirmation.
- Runner: `iwik withdraw <run_id...> --reason <code>` and the MCP `withdraw_contribution` tool switch from `not_yet_available` to real calls.
- Feature flag `IWIK_FEATURE_WITHDRAWAL` (default off → endpoint `404`, console form hidden, tool returns `feature_disabled` with `next_step`).

## Interface contracts

- **Exposes:** `POST /v1/withdrawals`; `stale` receipts; worker job kinds.
- **Consumes:** `member-api` v1, `evidence-envelope` v1 (`AnswerReceipt.status` already includes `stale`), `agent-tools` v1.

## Testing requirements

- Withdraw two of three runs → revision increments once; the withdrawn rows carry `withdrawn_revision`; a query receipt issued before reads `stale`; an intake receipt does not.
- Cross-org run id in the set → `404` and nothing withdrawn.
- Worker: expired previews reaped, unexpired kept; a job that throws is retried with backoff and lands in `failed` with `last_error` after 5 attempts; two workers on the same queue never run the same job (SKIP LOCKED test).
- MCP `withdraw_contribution` end-to-end against the service.
- UI-smoke asset `smoke/withdrawal.md`.

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag (default OFF) for this net-new feature: `IWIK_FEATURE_WITHDRAWAL`
- [ ] UI-smoke "observably-works" check authored for any user-facing surface: `smoke/withdrawal.md`
- [ ] Additive migration only (no destructive schema change)
- [ ] Existing suite stays green; CI all-green
- [ ] No response ever names another organization's run ids.

## Pipeline test: NO
