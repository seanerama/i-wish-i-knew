-- Up Migration
-- Stage 9: the real cooperative evidence query. Additive only: one new table
-- and one partial index; no rewrite of earlier migrations and no destructive
-- change (ADR-0002).

-- Every released cohort, for the differencing defence (ADR-0002 §4: a query
-- whose released cohort would differ from a prior release by fewer than 3
-- organizations is suppressed). Organizations are never stored here in the
-- clear: `member_org_hashes` holds one HMAC-SHA256 per member organization
-- under a key derived from the service KEK (HKDF, info
-- "iwik-cohort-release-v1"), sorted, and `member_orgs_hash` is the SHA-256
-- over that sorted list, so "the same set again" is one string comparison.
-- `org_count` / `run_count` are exact because this table is inside the trust
-- boundary; nothing reads them onto the wire.
CREATE TABLE evidence.cohort_releases (
  release_id         text PRIMARY KEY,
  query_digest       text NOT NULL,
  protocol_ref       text NOT NULL,
  filters            jsonb NOT NULL,
  member_orgs_hash   text NOT NULL,
  member_org_hashes  text[] NOT NULL,
  org_count          integer NOT NULL,
  run_count          integer NOT NULL,
  revision           bigint NOT NULL,
  receipt_id         text NOT NULL,
  released_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cohort_releases_protocol_ref_idx
  ON evidence.cohort_releases (protocol_ref, released_at DESC);

-- The candidate scan of the query path: releasable rows of one protocol.
CREATE INDEX runs_cohort_candidates_idx
  ON evidence.runs (protocol_ref, evidence_revision)
  WHERE withdrawn_at IS NULL AND is_fixture = false AND duplicate_of IS NULL
    AND sharing_policy = 'cooperative' AND index_version IS NOT NULL;
