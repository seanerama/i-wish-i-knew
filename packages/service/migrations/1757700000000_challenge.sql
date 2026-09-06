-- Up Migration
-- Stage 10: the challenge and outcome ledger (brief R9, R10). Additive only:
-- five new tables and one trigger; no rewrite of earlier migrations and no
-- destructive change (ADR-0002). Every row here carries the opaque org_ref
-- of the organization that owns it and never another organization's run,
-- node, or org identifier; challenge notes are bounded free text seen by the
-- filing organization and the operator only.

-- One claim per finding released on a receipt (origin measured, corroboration
-- unreplicated, status supported), created inside the release transaction and
-- idempotent on (receipt_id, claim_key); a challenge that is resolved gets a
-- counter-claim of its own (receipt_id NULL, origin reported). `payload` is
-- the Claim entity body (statement, derivation, limitations): bands and
-- fixed vocabulary only, never run ids.
CREATE TABLE evidence.claims (
  claim_id           text PRIMARY KEY,
  receipt_id         text,
  org_ref            text NOT NULL,
  protocol_ref       text NOT NULL,
  claim_key          text NOT NULL,
  status             text NOT NULL,
  origin             text NOT NULL,
  corroboration      text NOT NULL,
  payload            jsonb NOT NULL,
  evidence_revision  bigint NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX claims_receipt_key_idx
  ON evidence.claims (receipt_id, claim_key) WHERE receipt_id IS NOT NULL;
CREATE INDEX claims_org_ref_idx ON evidence.claims (org_ref, created_at DESC);

-- A structured challenge against a receipt the filer holds or a claim released
-- on one. `receipt_id` is the receipt the target resolves to (the filer's
-- own). `statement` holds the fixed-vocabulary fields plus the one bounded
-- `note`. Lifecycle: open -> acknowledged -> resolved (upheld | rejected |
-- superseded); resolution is an operator action that records a relationship
-- and bumps the evidence revision (`resolved_revision`).
CREATE TABLE evidence.challenges (
  challenge_id       text PRIMARY KEY,
  org_ref            text NOT NULL,
  node_id            text,
  protocol_ref       text NOT NULL,
  target_kind        text NOT NULL,
  target_id          text NOT NULL,
  receipt_id         text NOT NULL,
  grounds            text NOT NULL,
  statement          jsonb NOT NULL DEFAULT '{}'::jsonb,
  evaluation_method  text NOT NULL DEFAULT 'operator_review',
  status             text NOT NULL DEFAULT 'open',
  resolution         text,
  relationship_id    text,
  resolved_revision  bigint,
  filed_at           timestamptz NOT NULL DEFAULT now(),
  acknowledged_at    timestamptz,
  resolved_at        timestamptz
);
CREATE INDEX challenges_org_ref_filed_idx ON evidence.challenges (org_ref, filed_at DESC);
CREATE INDEX challenges_status_filed_idx ON evidence.challenges (status, filed_at);

-- supports / contradicts / reproduces / narrows / supersedes between two
-- claims, with a fixed-vocabulary rationale and the revision it took effect
-- at. A challenge resolution writes one per claim of the targeted receipt.
CREATE TABLE evidence.relationships (
  relationship_id    text PRIMARY KEY,
  source_claim_id    text NOT NULL,
  target_claim_id    text NOT NULL,
  kind               text NOT NULL,
  rationale          text NOT NULL,
  revision           bigint NOT NULL,
  challenge_id       text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX relationships_target_idx ON evidence.relationships (target_claim_id);
CREATE INDEX relationships_challenge_idx ON evidence.relationships (challenge_id);

-- A prediction registered before its outcome is known (brief §7 "Outcome
-- learning"): target, horizon, probability, evaluation rule, and when it
-- was registered. Rows are write-once: the trigger below refuses every
-- UPDATE, so an observation can never alter the prediction it reports on.
CREATE TABLE evidence.predictions (
  prediction_id        text PRIMARY KEY,
  org_ref              text NOT NULL,
  node_id              text,
  based_on_receipt_id  text NOT NULL,
  protocol_ref         text NOT NULL,
  target               jsonb NOT NULL,
  horizon              date NOT NULL,
  probability          double precision,
  evaluation_rule      text NOT NULL,
  registered_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX predictions_org_ref_idx ON evidence.predictions (org_ref, registered_at DESC);

CREATE FUNCTION evidence.predictions_are_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'evidence.predictions rows are immutable'
    USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER predictions_immutable
  BEFORE UPDATE ON evidence.predictions
  FOR EACH ROW EXECUTE FUNCTION evidence.predictions_are_immutable();

-- The observation, recorded later, exactly once per prediction. `result`
-- (met | not_met | indeterminate) and `environment_changed` are separate
-- columns: a changed environment is never folded into "prediction wrong".
CREATE TABLE evidence.outcomes (
  outcome_id           text PRIMARY KEY,
  prediction_id        text NOT NULL UNIQUE REFERENCES evidence.predictions (prediction_id),
  org_ref              text NOT NULL,
  observed_at          timestamptz NOT NULL,
  result               text NOT NULL,
  environment_changed  boolean NOT NULL,
  evaluation_run_id    text,
  recorded_at          timestamptz NOT NULL DEFAULT now()
);
