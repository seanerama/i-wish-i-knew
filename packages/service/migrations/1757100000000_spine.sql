-- Up Migration
-- Stage 2: the service spine. Additive only (no destructive change may ever
-- be added to this file or a later one). Two schemas with one opaque join
-- (ADR-0002): `identity` knows who an organization is; `evidence` knows only
-- the opaque org_ref.

CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS evidence;

CREATE TABLE identity.organizations (
  org_id      text PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identity.org_refs (
  org_id      text PRIMARY KEY REFERENCES identity.organizations (org_id),
  org_ref     text NOT NULL UNIQUE
);

CREATE TABLE identity.nodes (
  node_id     text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES identity.organizations (org_id),
  pubkey      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE INDEX nodes_org_id_idx ON identity.nodes (org_id);

CREATE TABLE identity.tokens (
  token_hash  text PRIMARY KEY,
  node_id     text NOT NULL REFERENCES identity.nodes (node_id),
  scopes      text[] NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE INDEX tokens_node_id_idx ON identity.tokens (node_id);

-- Per-organization data keys, wrapped with the service KEK (AES-256-GCM).
-- The plaintext data key exists only in process memory.
CREATE TABLE identity.org_keys (
  org_ref      text PRIMARY KEY,
  key_id       text NOT NULL UNIQUE,
  wrapped_key  bytea NOT NULL,
  kek_id       text NOT NULL DEFAULT 'env',
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Evidence revision: a singleton counter incremented on every accepted run.
CREATE TABLE evidence.revision (
  singleton   boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision    bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO evidence.revision (singleton, revision) VALUES (true, 0);

CREATE TABLE evidence.runs (
  run_id             text PRIMARY KEY,
  org_ref            text NOT NULL,
  protocol_ref       text NOT NULL,
  protocol_digest    text NOT NULL,
  harness_digest     text NOT NULL,
  execution_status   text NOT NULL,
  content_digest     text NOT NULL,
  body_ciphertext    bytea NOT NULL,
  key_id             text NOT NULL,
  receipt_id         text NOT NULL,
  evidence_revision  bigint NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runs_org_ref_idx ON evidence.runs (org_ref, received_at DESC);
CREATE INDEX runs_protocol_ref_idx ON evidence.runs (protocol_ref);

CREATE TABLE evidence.receipts (
  receipt_id         text PRIMARY KEY,
  org_ref            text NOT NULL,
  kind               text NOT NULL,
  status             text NOT NULL,
  payload            jsonb NOT NULL,
  evidence_revision  bigint NOT NULL,
  issued_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX receipts_org_ref_idx ON evidence.receipts (org_ref, issued_at DESC);

CREATE TABLE evidence.previews (
  preview_id      text PRIMARY KEY,
  org_ref         text NOT NULL,
  content_digest  text NOT NULL,
  expires_at      timestamptz NOT NULL
);
CREATE INDEX previews_expires_at_idx ON evidence.previews (expires_at);

-- Durable jobs for the worker (ADR-0001): rows, idempotency keys, bounded retries.
CREATE TABLE jobs (
  job_id           text PRIMARY KEY,
  kind             text NOT NULL,
  idempotency_key  text NOT NULL UNIQUE,
  state            text NOT NULL DEFAULT 'queued',
  attempts         integer NOT NULL DEFAULT 0,
  run_after        timestamptz NOT NULL DEFAULT now(),
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_state_run_after_idx ON jobs (state, run_after);
