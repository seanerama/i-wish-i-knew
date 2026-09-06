-- Up Migration
-- Stage 8: intake dedupe, organization concentration accounting, and the
-- plaintext index projection. Additive only: new nullable or defaulted
-- columns, new indexes, one new table; no rewrite of earlier migrations and
-- no destructive change (ADR-0002).

-- The plaintext index projection of a run. Every column here is derived
-- from the encrypted body at intake (or by the `index_backfill` worker job
-- for rows that predate this migration) and is trustworthy only once
-- `index_version` is set; a row with `index_version IS NULL` is never used
-- to form or count a cohort.
--
--   measurement_digest     sha256 over the JCS form of { protocol_digest,
--                          target_label_digest, result, attempts_summary }
--                          (modules/intake/projection.ts): the same
--                          measurement uploaded twice has the same digest
--   node_id                the submitting node (already on the receipt)
--   index_context          only the protocol's required_context keys, each
--                          as { value, origin }; nothing else is projected
--   is_fixture             target.kind = fixture; never counted (ADR-0003)
--   shared_source_suspect  the same measurement_digest arrived from more
--                          than one organization (brief: shared source)
--   duplicate_of           the earlier run of the SAME organization with the
--                          same measurement_digest; a duplicate is stored but
--                          never counted
ALTER TABLE evidence.runs ADD COLUMN measurement_digest text;
ALTER TABLE evidence.runs ADD COLUMN node_id text;
ALTER TABLE evidence.runs ADD COLUMN index_context jsonb;
ALTER TABLE evidence.runs ADD COLUMN is_fixture boolean NOT NULL DEFAULT false;
ALTER TABLE evidence.runs ADD COLUMN index_version integer;
ALTER TABLE evidence.runs ADD COLUMN shared_source_suspect boolean NOT NULL DEFAULT false;
ALTER TABLE evidence.runs ADD COLUMN duplicate_of text;
CREATE INDEX runs_measurement_digest_idx ON evidence.runs (protocol_ref, measurement_digest);
CREATE INDEX runs_index_context_idx ON evidence.runs USING gin (index_context);

-- Concentration accounting per (protocol, organization), maintained inside
-- the intake and withdrawal transactions and repaired by `index_backfill`.
-- Fixture runs and same-organization duplicates never touch it, so
-- `runs_accepted` is the number of distinct measurements an organization
-- currently contributes to a protocol (ADR-0002 thresholds, ADR-0003: one
-- contributor = one organization).
CREATE TABLE evidence.contributions (
  protocol_ref    text NOT NULL,
  org_ref         text NOT NULL,
  runs_accepted   integer NOT NULL DEFAULT 0,
  runs_withdrawn  integer NOT NULL DEFAULT 0,
  last_received   timestamptz,
  PRIMARY KEY (protocol_ref, org_ref)
);
