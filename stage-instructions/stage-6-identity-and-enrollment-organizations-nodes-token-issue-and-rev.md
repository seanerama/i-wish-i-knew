# Stage 6: Identity and enrollment: organizations, nodes, token issue and revoke

- **Type:** feature
- **Depends on:** 2
- **Milestone:** 0.2 local investigation
- **Work-item:** https://github.com/seanerama/i-wish-i-knew/issues/6
- **Design refs:** ADR-0002 (identity/evidence separation), ADR-0006 (tokens, scopes); brief R5, R11, R12; `contracts/member-api.md`

## Objectives

Replace the environment-seeded organization with real enrollment so a second
member can exist. Organizations enroll, register runner nodes with their public
keys, issue scoped tokens, and revoke them. This is the first stage of the
protected cooperative (brief phase 3) and a prerequisite for any multi-org
test.

## What to build

**packages/service**
- Operator bootstrap: `IWIK_OPERATOR_TOKEN` (env) authorizes `POST /v1/admin/organizations` only; this is the only admin surface in this stage.
- Console (server-rendered, progressive enhancement):
  - `/enroll/<invite>`: an organization accepts an invite created by the operator, sets its display name, and agrees to the pilot terms including the ADR-0002 trust-boundary statement and the reciprocity clause (R11) — agreement is recorded with a timestamp and the terms version.
  - `/org`: list nodes; register a node by pasting the public key printed by `iwik init`; issue a token with chosen scopes (`query`, `submit`, `publish`); show the token once; revoke tokens and nodes.
  - Session: cookie session for the organization's console login via a magic link emailed… **no**: email is out of scope. Use an operator-issued console password set at enrollment, bcrypt-hashed, with rate limiting. Note this as pilot-only in the assessment.
- Migrations (additive): `identity.invites`, `identity.agreements`, `identity.console_logins`, and `revoked_at` handling already present in stage 2 tables.
- Token/revocation enforcement in the auth hook: revoked token → `401`, revoked node → `401` for all its tokens, and intake rejects signatures from revoked nodes.
- Audit log table `identity.audit(event, actor, target, at)` for issue/revoke/enroll, no evidence content.
- Feature flag `IWIK_FEATURE_ENROLLMENT` (default off): when off, `/enroll` and `/org` return `404` and the env-seeded node keeps working.

**packages/runner**
- `iwik init` prints the enrollment instructions pointing at `/org`.

## Interface contracts

- **Exposes:** enrollment and node management console; `POST /v1/admin/organizations` (operator scope). Additive to `member-api` v1: new endpoints only.
- **Consumes:** stage-2 identity tables and auth hook.

## Testing requirements

- Two organizations enroll; each registers a node and issues a token; a run submitted by org A is not visible via `GET /v1/runs/{id}` with org B's token (`404`, not `403`, to avoid existence leaks).
- Revocation: revoke token → `401`; revoke node → its signature is rejected at intake.
- Scope matrix: each endpoint × each scope → expected `200/403`.
- Console login rate limit: 6th failed attempt in a minute → `429`.
- Flag off → `/enroll` is `404`, seeded node still submits.

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag (default OFF) for this net-new feature: `IWIK_FEATURE_ENROLLMENT`
- [ ] UI-smoke "observably-works" check authored for any user-facing surface: `smoke/enrollment.md` — operator creates an invite, an org enrolls, registers a node, issues a token, `iwik submit` succeeds, revoke, `iwik submit` fails with `401`.
- [ ] Additive migration only (no destructive schema change)
- [ ] Existing suite stays green; CI all-green
- [ ] Tokens are shown exactly once and stored only as hashes (test asserts no plaintext column).

## Pipeline test: NO
