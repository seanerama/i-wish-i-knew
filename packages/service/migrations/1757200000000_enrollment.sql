-- Up Migration
-- Stage 6: identity and enrollment. Additive only: new tables in the identity
-- schema and new nullable-then-backfilled columns. Nothing here touches the
-- evidence schema; audit rows carry identifiers and event names only.

-- One-time invites minted by the operator (POST /v1/admin/organizations).
-- The invite token is stored as its SHA-256 only; the URL is shown once.
CREATE TABLE identity.invites (
  invite_hash  text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES identity.organizations (org_id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz
);
CREATE INDEX invites_org_id_idx ON identity.invites (org_id);

-- Console sign-in for an organization: an operator-set password chosen at
-- enrollment (pilot-only shortcut, feature-assessments/initial-backlog-
-- assessment.md), stored as an scrypt hash.
CREATE TABLE identity.console_logins (
  login_id       text PRIMARY KEY,
  org_id         text NOT NULL REFERENCES identity.organizations (org_id),
  password_hash  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz
);
CREATE INDEX console_logins_org_id_idx ON identity.console_logins (org_id);

-- The pilot terms an organization agreed to at enrollment: which version,
-- which clauses (terms, ADR-0002 trust statement, R11 reciprocity), and when.
CREATE TABLE identity.agreements (
  agreement_id   text PRIMARY KEY,
  org_id         text NOT NULL REFERENCES identity.organizations (org_id),
  login_id       text NOT NULL REFERENCES identity.console_logins (login_id),
  terms_version  text NOT NULL,
  clauses        text[] NOT NULL,
  accepted_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agreements_org_id_idx ON identity.agreements (org_id);

-- Audit trail for enrol / register / issue / revoke. `actor` and `target` are
-- identifiers (login id, node id, token id, org id), never evidence content.
CREATE TABLE identity.audit (
  audit_id  text PRIMARY KEY,
  event     text NOT NULL,
  actor     text NOT NULL,
  target    text NOT NULL,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_at_idx ON identity.audit (at DESC);

-- Tokens gain a public identifier so the console can name one for revocation
-- without ever showing the hash. Rows issued before this migration get a
-- stable identifier derived from the (non-secret) hash prefix.
ALTER TABLE identity.tokens ADD COLUMN token_id text;
UPDATE identity.tokens SET token_id = 'tk_' || left(token_hash, 24) WHERE token_id IS NULL;
ALTER TABLE identity.tokens ALTER COLUMN token_id SET NOT NULL;
CREATE UNIQUE INDEX tokens_token_id_idx ON identity.tokens (token_id);

-- When the organization completed enrollment (NULL for env-seeded orgs).
ALTER TABLE identity.organizations ADD COLUMN enrolled_at timestamptz;
