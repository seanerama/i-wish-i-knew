# 0001. Choose TypeScript modular monolith with Fastify and PostgreSQL

- **Status:** Accepted
- **Date:** 2026-09-05

## Context

The brief (`i-wish-i-knew-architect-brief.md` §8) asks for a small codebase holding
contracts, a protocol registry, ingestion, matching, policy, and receipts; a
background worker for validation and recomputation; a separate local runner CLI;
an MCP adapter exposing narrow tools; and a minimal server-rendered member
console. It suggests Python + FastAPI first and names TypeScript as a reasonable
alternative "if it improves team throughput".

The Verity `stack-and-topology` guide recommends a boring, well-supported stack,
a modular monolith, server-rendered UI with progressive enhancement, and pinned
dependencies with a committed lockfile.

Forces:

- The runner CLI, the MCP adapter, and the service all consume the same evidence
  contract. Drift between them is the most likely class of bug (R1, R2).
- The operator's existing tooling is Node-based (Verity itself, the Cloudflare
  projects, the Expo client). One toolchain lowers day-to-day cost.
- The MCP reference SDK for TypeScript is first-class; the runner ships the MCP
  adapter (ADR-0006).
- Statistics for aggregation are modest at pilot scale (distribution summaries,
  cohort thresholds), not heavy numerical work.

## Decision

**TypeScript on Node 22 LTS, one repository, npm workspaces, one deployable image.**

```
packages/contracts   TypeBox schemas → committed JSON Schema (ADR-0005); shared types
packages/service     Fastify HTTP API + server-rendered console + worker entrypoint
packages/runner      `iwik` CLI: local vault, harness executor, submit, `iwik mcp`
packs/               domain packs (first: inference-api) — data + harness, not a package
contracts/           frozen contract documents + generated schema artifacts
docs/adr/            decision records
```

- **HTTP:** Fastify 5. Native JSON Schema validation (Ajv) and OpenAPI generation
  fit a contract-heavy service; it is boring and well supported.
- **Storage:** PostgreSQL 16 via `pg`, SQL migrations via `node-pg-migrate`.
  Explicit relationship tables with bounded traversal, no graph engine (brief §8).
- **Worker:** the same image started with a different command
  (`node dist/worker.js`); durable jobs are rows in a `jobs` table with
  idempotency keys and bounded retries. No queue broker until measured need.
- **Console:** server-rendered templates (Eta via `@fastify/view`) with progressive
  enhancement. No SPA, no client build step.
- **Runner:** published to npm as `i-wish-i-knew` (name reserved at identity lock)
  exposing the `iwik` binary. It is a package, not a deployed service.
- **Image:** `ghcr.io/seanerama/i-wish-i-knew` (service + worker + console). The
  runner has no image.
- **Pinning:** `.nvmrc` = 22, `engines` enforced, `package-lock.json` committed,
  exact versions.

## Alternatives considered

- **Python + FastAPI** (the brief's first suggestion). Stronger numerical
  libraries. Rejected for the pilot: it forces two toolchains (runner/MCP in TS
  or a Python CLI plus a second packaging story), and the contracts package
  could not be shared as compiled types. Revisit if aggregation outgrows
  TypeScript; a stats worker can be split out behind the `member-api` and
  `evidence-envelope` contracts without touching the runner.
- **Multi-service from day one** (registry, intake, compute, console as separate
  services). Rejected per the guide: each service multiplies CI, images, and
  deploy surface. The module boundaries exist in code; they split only on
  demonstrated need.
- **Express / Hono** instead of Fastify. Both fine; Fastify's schema-first
  validation and OpenAPI output are the deciding fit.
- **SPA console.** Rejected: the console is a handful of forms and receipt views.

## Consequences

- One CI matrix, one image, one lockfile. The runner and service compile against
  the same contracts, so envelope drift fails at build time.
- Statistics live in TypeScript: every aggregate must have a fixture-backed test
  and a documented analysis unit (ADR-0003). This is a discipline cost, accepted.
- The worker shares the service's process model, so a long-running job cannot
  starve the API; job bodies must be small and resumable.
- The drop-in `helper-bot` feature is **deferred**: the product has no in-app
  chat loop, and a log-reading help agent sits awkwardly with R6 (private data
  out of model prompts). Reconsider after the console has real users.
