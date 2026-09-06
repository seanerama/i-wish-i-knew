-- Up Migration
-- Stage 7: withdrawal, revision-keyed staleness, and the worker job loop.
-- Additive only: new nullable or defaulted columns, new tables, no rewrite
-- of earlier migrations and no destructive change (ADR-0002 §6).

-- Runs gain their sharing policy as a plaintext column (it is already carried
-- by the intake receipt, so nothing new is disclosed) and the withdrawal
-- marks. `sharing_policy` defaults to 'private' (the safe value) and is
-- trustworthy only once `backfill_version` is set: intake sets both on
-- insert, and the worker job `sharing_backfill` fills rows that predate this
-- migration from their decrypted bodies.
ALTER TABLE evidence.runs ADD COLUMN sharing_policy text NOT NULL DEFAULT 'private';
ALTER TABLE evidence.runs ADD COLUMN backfill_version integer;
ALTER TABLE evidence.runs ADD COLUMN withdrawn_at timestamptz;
ALTER TABLE evidence.runs ADD COLUMN withdrawn_revision bigint;

-- One row per withdrawal request. `run_ids` is stored sorted and de-duplicated
-- so the same set from the same organization is one withdrawal (idempotent).
CREATE TABLE evidence.withdrawals (
  withdrawal_id       text PRIMARY KEY,
  org_ref             text NOT NULL,
  run_ids             text[] NOT NULL,
  reason_code         text NOT NULL,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  effective_revision  bigint NOT NULL
);
CREATE INDEX withdrawals_org_ref_idx ON evidence.withdrawals (org_ref, requested_at DESC);
CREATE UNIQUE INDEX withdrawals_org_set_idx ON evidence.withdrawals (org_ref, run_ids);

-- Which protocol each evidence revision touched, and why. A query receipt is
-- stale when a later revision touched its protocol; intake and withdrawal
-- both write here. Existing runs are projected in so receipts issued before
-- this migration compare correctly.
CREATE TABLE evidence.revision_log (
  revision      bigint NOT NULL,
  protocol_ref  text NOT NULL,
  kind          text NOT NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (revision, protocol_ref)
);
CREATE INDEX revision_log_protocol_ref_idx ON evidence.revision_log (protocol_ref, revision DESC);
INSERT INTO evidence.revision_log (revision, protocol_ref, kind, at)
  SELECT evidence_revision, protocol_ref, 'intake', received_at FROM evidence.runs
  ON CONFLICT DO NOTHING;

-- Revision-keyed derived state (empty until stage 9). `withdrawal_apply`
-- evicts rows of an affected protocol computed before the withdrawal's
-- effective revision.
CREATE TABLE evidence.cache (
  key           text PRIMARY KEY,
  protocol_ref  text NOT NULL,
  revision      bigint NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cache_protocol_ref_idx ON evidence.cache (protocol_ref, revision);

-- Worker observability: the last failure (our own error text, never a
-- submitted value) and who holds a running job since when.
ALTER TABLE jobs ADD COLUMN last_error text;
ALTER TABLE jobs ADD COLUMN locked_at timestamptz;
ALTER TABLE jobs ADD COLUMN locked_by text;
