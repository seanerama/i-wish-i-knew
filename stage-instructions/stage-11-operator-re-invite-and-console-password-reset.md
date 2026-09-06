# Stage 11: Operator re-invite and console password reset

- **Type:** feature
- **Depends on:** none
- **Milestone:** 0.3 protected cooperative answers
- **Work-item:** https://github.com/seanerama/i-wish-i-knew/issues/17
- **Design refs:** stage 6 review carry-forward; ADR-0006; `contracts/member-api.md` operator endpoints

## Objectives

Close the enrollment gap found in review: an existing organization can be
re-invited (lost password, new admin) without creating a second organization,
and the console copy stops promising something the API cannot do.

## What to build

**packages/service**
- `POST /v1/admin/organizations/{org_id}/invites` (operator token): creates a one-time reset invite for an existing org; `409` if an unexpired one exists; audit row.
- `/enroll/<invite>` handles reset invites: sets a new console password for the existing org, records a new agreement row only if the terms version changed, keeps nodes and tokens intact.
- Console copy in `login.eta` and `enroll.eta` reworded to match; `org.eta` token notice reworded ("a resubmitted form issues another token").
- Global per-IP login bucket in addition to the per-org bucket (stage 6 review carry-forward), both behind `IWIK_TRUST_PROXY`.
- CSRF nonce rotated on login.
- Migration (additive): `identity.invites.kind` (`enroll`|`reset`, default `enroll`).

## Interface contracts

- **Exposes:** re-invite endpoint (additive, operator scope).
- **Consumes:** stage 6 identity tables and console.

## Testing requirements

- Reset flow: org enrolls, password reset via re-invite, old password fails, nodes/tokens unchanged, single organization row.
- Second unexpired reset invite → `409`.
- Per-IP bucket: varying org names from one IP → `429` on the 6th failure.
- CSRF token differs before and after login.
- `smoke/enrollment.md` extended with the reset path.

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag (default OFF) for this net-new feature: rides `IWIK_FEATURE_ENROLLMENT` (no new flag; reset routes are `404` when enrollment is off)
- [ ] UI-smoke "observably-works" check authored for any user-facing surface: `smoke/enrollment.md` (extended)
- [ ] Additive migration only (no destructive schema change)
- [ ] Existing suite stays green; CI all-green

## Pipeline test: NO
