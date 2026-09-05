# Contract: agent-tools

- **Status:** frozen v1
- **Owner:** `packages/runner` (`iwik mcp`, stdio transport, ADR-0006)

The tool surface an agent sees. Each tool is a thin projection of one
`member-api` call or one local runner action. Nothing here bypasses the
disclosure policy or the local execution policy.

## Exposes

| Tool | Scope / policy | Side effect | Maps to |
|---|---|---|---|
| `get_protocol` | `query` | read | `GET /v1/protocols/{ref}` |
| `query_evidence` | `query` | read (rate-limited) | `POST /v1/evidence/query` |
| `plan_test` | `query` | local write (plan saved under `~/.iwik/plans/`) | runner: choose protocol, target, context; returns `plan_id`, estimated cost, and what uncertainty it resolves |
| `run_test` | **local policy** `allow_execution` + budget | paid / possibly disruptive | runner: execute `plan_id`; denied by default, returns the `iwik run` command for the operator |
| `preview_contribution` | `submit` | read | `POST /v1/contributions/preview` |
| `submit_run` | `submit` | remote write | `POST /v1/runs` with `preview_id` |
| `get_receipt` | `query` | read | `GET /v1/receipts/{id}` |
| `challenge_finding` | `publish` | remote write | `POST /v1/challenges` |
| `report_outcome` | `publish` | remote write | `POST /v1/outcomes` |
| `withdraw_contribution` | `publish` | remote write | `POST /v1/withdrawals` |

## Consumes

- `member-api` v1.
- `runner-pack` v1 for `plan_test` and `run_test`.
- `~/.iwik/policy.json` and the node token / signing key under `~/.iwik/`.

## Schema / wire

Tool inputs and outputs are JSON Schema objects generated from
`packages/contracts` (ADR-0005) and published in `contracts/schema/v1/tools/`.

Common output envelope:

```jsonc
{ "ok": true, "data": { … } }
{ "ok": false, "error": { "code": "policy_denied|scope_required|suppressed|insufficient_evidence|validation_failed|…", "message": "…", "next_step": "…" } }
```

`next_step` is human-actionable text (for example the exact CLI command an
operator must run). Error messages never include private field values.

**Skill text.** The runner ships `SKILL.md` describing when to query, how to
read applicability and uncertainty, and when to propose a test. The skill is
guidance; enforcement is in the tools.

## Versioning

Frozen at **v1**. Changes are **additive only** — a breaking change is a NEW
contract, not an edit (framework-spec §4.3). Every consumer depends on this shape.
New tools may be added; existing tool names, required inputs, and the output
envelope do not change.
