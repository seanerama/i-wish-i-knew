# Assessment: initial thin backlog (Mode A)

- **Date:** 2026-09-05
- **Input:** `docs/architecture.md`, `docs/walking-skeleton.md`, ADR-0001..0006, the brief.
- **Decision:** ACCEPT as six dependency-ordered stages across two milestones. Phases 3 (rest), 4, and 5 of the brief are **deferred** to a second planning pass once stage 5 lands and the contracts have survived contact with a real agent.

## Claim / reality check against the live codebase

| Claim in the design | Reality on `main` at `ad309b2` | Consequence |
|---|---|---|
| `packages/contracts`, `packages/service`, `packages/runner`, `packs/` exist | None exist; the repo holds docs, contracts, scaffold files, `.verity/gates.json`, `.nvmrc` | Stage 1 creates the monorepo root; every later stage assumes it |
| Gates: `npm ci`, `contracts:check`, `typecheck`, `lint`, `test`, `docker build` | Committed in `.verity/gates.json`; no `package.json` or `Dockerfile`, so CI is red at `npm ci` | Stage 1 must satisfy all six gates, including a placeholder `Dockerfile`, so CI goes green in the first PR |
| CI gates job provides Node 22 and Postgres 16 with `DATABASE_URL` and `IWIK_KEK` | Present in `.github/workflows/ci.yml` | Stage 2's spine test can rely on it |
| Four frozen contracts | Present as markdown; no schema JSON yet | Stage 1 turns them into TypeBox + committed JSON; any mismatch found while coding is an additive fix to the markdown, never a semantic change |
| Deployment targets and access | `.verity/deploy-access.md` exists locally (gitignored) and the pointer is committed | Stage 4 builds artifacts only; `/verity:ship` performs deploys |
| Identity is env-seeded until enrollment exists | No code yet | Stage 2 seeds; stage 6 replaces, behind a flag |

No claim in the design contradicts the repo. The only open assumption is that
the walking-skeleton test is feasible in CI's time budget; twenty stub
requests at 20 ms is well under a second.

## Splits and why

- The walking skeleton (docs "Stage 0") is **split into stages 1–4** so that CI
  turns green in the first PR (stage 1) rather than after a large combined
  change, and so the service and runner halves can be reviewed separately
  against their own contracts. Stage 3 owns the end-to-end test.
- Stage 4 is separated so the release pipeline can be reviewed as
  infrastructure and so it does not block stage 3.
- Stage 5 (local investigation, MCP) and stage 6 (enrollment) are independent
  of each other and can proceed in parallel after their dependencies.

## Contract safety

All six stages are additive against the four frozen contracts. Stage 5 adds
`contracts/schema/v1/tools/` (declared in `agent-tools`) and a stub
`POST /v1/evidence/query` that is already listed in `member-api`. Stage 6 adds
`POST /v1/admin/organizations`, a new endpoint under `/v1`, allowed by the
additive rule. **No new contract and no ADR is needed for this batch.**

## Deferred, with the trigger to plan them

| Deferred item | Plan when |
|---|---|
| Intake hardening: dedupe of repeated uploads and derivative summaries, contribution caps, org concentration (phase 3) | after stage 6 |
| Withdrawal, receipts going `stale`, evidence revision caches (phase 3) | after stage 6 |
| Matching, aggregation, suppression, real `evidence/query` (phase 4) | after stages 5 and 6 |
| Challenge and outcome ledger (phase 4) | after matching |
| Second-domain fixture, replication, operator-exclusion ADR (phase 5) | after phase 4 |
| `helper-bot` drop-in | not accepted (ADR-0001) |

## Pilot-only shortcuts recorded here so they are not forgotten

- Console login in stage 6 uses an operator-set password, not email magic links.
- The egress guard in stage 3 is a Node-level monkey-patch, best effort; a
  process-level sandbox is a later SRE/security stage.
- Env-seeded identity in stage 2 is removed only when stage 6's flag is on.
