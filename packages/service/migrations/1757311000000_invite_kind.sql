-- Up Migration
-- Stage 11: operator re-invite. Additive only: an invite now carries a kind.
--   enroll  the original one-time enrollment invite (stage 6; the default,
--           so every existing row keeps its meaning)
--   reset   a one-time console password reset for an already enrolled
--           organization (POST /v1/admin/organizations/{org_id}/invites)
ALTER TABLE identity.invites ADD COLUMN kind text NOT NULL DEFAULT 'enroll';
ALTER TABLE identity.invites
  ADD CONSTRAINT invites_kind_check CHECK (kind IN ('enroll', 'reset'));
