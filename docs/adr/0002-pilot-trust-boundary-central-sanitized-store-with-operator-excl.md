# 0002. Pilot trust boundary: central sanitized store with operator-exclusion gate

- **Status:** Accepted
- **Date:** 2026-09-05

## Context

Brief §6 separates two promises: **member confidentiality** (peers cannot see
another member's records) and **operator confidentiality** (privileged cloud
administrators cannot inspect protected plaintext). It offers three
architectures: (A) central sanitized feature store, (B) encrypted features with
attested confidential computation, (C) federated computation / secure
aggregation. It asks the architect to decide whether privileged-operator
exclusion is required at pilot launch (decision item 2) and to set initial
privacy thresholds (item 5).

Nothing in the brief is ratified as an operator-exclusion promise. No real
member data exists yet. The contracts, matching, and aggregation logic are
unproven and will iterate fastest with inspectable data.

## Decision

**Build the pilot on option A with synthetic data, structured so that moving to
option B is a key-custody change rather than a schema change. Operator exclusion
is a gate before the first real-member release, not a pilot requirement.**

Controls in force from the walking skeleton onward:

1. **Two schemas, one opaque join.** `identity` (organizations, nodes, tokens,
   affiliations) and `evidence` (runs, context, claims, relationships) live in
   separate PostgreSQL schemas. Evidence rows carry only an opaque `org_ref`;
   the mapping table lives in `identity`.
2. **Per-organization envelope encryption.** Evidence feature rows are stored as
   ciphertext under a per-org data key, wrapped by a service key-encryption key.
   In the pilot the service holds the KEK, so **operators are inside the trust
   boundary and documentation must say so**. Under option B the same rows stay
   put and only key release moves behind attestation.
3. **Allowlisted envelope only.** The runner sanitizes locally against the
   `evidence-envelope` schema; free text, secrets, hostnames, and raw artifacts
   never leave the local vault. Intake rescans for secret patterns and rejects
   the whole submission on a hit, returning only the field path, never the value.
4. **Initial release thresholds** (revisable by a later ADR, never silently):
   - a cohort is releasable only with **≥ 3 distinct organizations** and
     **≥ 5 qualifying runs**;
   - **no single organization may supply > 50 %** of runs in a released cohort;
   - **fixed cohort releases**: an answer receipt pins the cohort at an evidence
     revision, and a narrower re-query whose cohort would differ from a prior
     release by fewer than 3 organizations is suppressed (differencing defense);
   - counts are released as ranges (3–5, 6–10, 11+), never exact below 11.
5. **No private rows to models.** Any language-model component receives only
   released aggregates and the requester's own records. Prompts, embeddings,
   logs, caches, and exports are covered by the same rule.
6. **Withdrawal semantics.** Withdrawal marks runs excluded at the next evidence
   revision; derived caches are keyed by revision and evicted; previously issued
   receipts show `stale` without exposing what was removed. Backups expire in
   30 days; delivered answers cannot be recalled (documented in the member
   agreement).

**Gate before first real-member release:** either (i) members sign an explicit
acknowledgement that operators are inside the trust boundary, or (ii) a working
confidential-compute key-release demonstration (AWS Nitro Enclaves is the first
candidate) passes review. Which one is chosen is a new ADR at pilot validation.

## Alternatives considered

- **Option B now.** Rejected for the pilot: enclave deployment, code-update
  review, and key management would front-load weeks of work before the
  contracts are proven, and the brief itself suggests comparing A and B on
  synthetic data first.
- **Option C (federated).** Kept as the fallback for members who cannot contribute
  features centrally. Rejected as the default because contextual matching and
  contradiction analysis need row-level access somewhere.
- **Option A with plain at-rest encryption only.** Rejected: it gives no path to
  B without a data migration.

## Consequences

- The pilot may not be marketed as "operators cannot see your data". README and
  console copy carry that statement until the gate passes.
- Envelope encryption adds a key-management module in the skeleton. Accepted.
- Threshold values are conservative and will suppress many early answers. That
  is the intended product behaviour ("no sufficiently supported answer" is a
  legitimate outcome).
