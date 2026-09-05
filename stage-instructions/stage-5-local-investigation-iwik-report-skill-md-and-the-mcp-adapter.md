# Stage 5: Local investigation: iwik report, SKILL.md, and the MCP adapter

- **Type:** feature
- **Depends on:** 3
- **Milestone:** 0.2 local investigation
- **Work-item:** https://github.com/seanerama/i-wish-i-knew/issues/5
- **Design refs:** brief §3 and §9 phase 2; ADR-0006; `contracts/agent-tools.md`

## Objectives

Make the product useful to the **first member with an empty commons** (brief
§1). An agent can ask, be told honestly that no shareable evidence exists, plan
and (with permission) run the missing test locally, and read a local report
that states its own limits. This is the first stage an agent talks to.

## What to build

**packages/runner**
- `iwik report <run_id|--protocol ref>`: local-only report from the vault:
  distributions per permitted claim, accounting, missing context, and a fixed
  header "Local evidence only — not corroborated by the cooperative". Markdown
  and JSON output.
- `iwik plan --protocol <ref> --target <url> --question "<text>" [--context …]`:
  writes `plans/<plan_id>.json` with the chosen protocol, target, required
  context (unknowns listed), estimated cost from the pack's `claims.json`
  `cost_model`, and what uncertainty it resolves. Never executes.
- `iwik run --plan <plan_id>` executes a saved plan under policy.
- `iwik mcp`: stdio MCP server (`@modelcontextprotocol/sdk`, pinned) exposing
  the ten tools of `contracts/agent-tools.md` with inputs/outputs validated by
  the schemas in `contracts/schema/v1/tools/` (add those to `@iwik/contracts`
  in this stage, additively). `query_evidence` calls the service and, while
  stage 7+ does not exist, the service's `POST /v1/evidence/query` returns
  `insufficient_evidence` with reason `no_cooperative_evidence` — add that
  stub endpoint to the service here, honest and minimal. `run_test` is denied
  unless policy allows and returns the exact `iwik run --plan` command.
  `challenge_finding`, `report_outcome`, `withdraw_contribution` return
  `not_yet_available` with a `next_step` pointing at the milestone — they are
  present so the tool surface is complete and frozen.
- `SKILL.md` at the runner package root: when to query, how to read
  applicability/uncertainty/freshness, when to propose a test, how to explain a
  suppressed answer, what never to send (secrets, hostnames, prompts).
- Feature flag `IWIK_MCP_ENABLED` (runner env, default off): `iwik mcp` refuses
  to start without it, printing why.

## Interface contracts

- **Exposes:** `agent-tools` v1 over stdio; `iwik report`, `iwik plan`.
- **Consumes:** `@iwik/runner` API (stage 3), `member-api` (`/v1/protocols`, preview, runs, receipts, the new `evidence/query` stub).

## Testing requirements

- MCP contract test: spawn `iwik mcp` with the SDK client; list tools and assert the ten names and their input schemas match `contracts/schema/v1/tools/`.
- `plan_test` → `run_test` denied by default → enable policy → `run_test` executes against the stub → `preview_contribution` → `submit_run` → `get_receipt`, all through MCP.
- `query_evidence` returns `ok:false, code:insufficient_evidence` and the report header states local-only.
- `SKILL.md` lint: a test asserts the file exists and contains the "never send" section.

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag (default OFF) for this net-new feature: `IWIK_MCP_ENABLED`
- [ ] UI-smoke "observably-works" check authored for any user-facing surface: `smoke/mcp.md` — attach `iwik mcp` to Claude Code, call `get_protocol`, `plan_test`, `run_test` (denied), then allowed; read the local report.
- [ ] Additive migration only (no destructive schema change): only the `evidence/query` stub route, no schema change.
- [ ] Existing suite stays green; CI all-green

## Pipeline test: NO
