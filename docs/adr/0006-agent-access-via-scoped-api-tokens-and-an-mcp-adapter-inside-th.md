# 0006. Agent access via scoped API tokens and an MCP adapter inside the runner CLI

- **Status:** Accepted
- **Date:** 2026-09-05

## Context

Agents are the primary clients (brief §4, §8). Requirements: running a test and
sharing its results are separate permissions, local owners control targets,
credentials, budgets, and disruptive activity (R12); the cloud must not become
a route for arbitrary remote commands into member environments (§4); separate
scopes for querying, submitting, running, and publishing prevent a query from
silently triggering a costly test (§8). The brief lists nine tool concepts and
leaves names and payloads open.

## Decision

**Authentication.** Each runner node holds an opaque, random **node token**
issued by its organization through the console. Tokens are stored hashed,
presented as `Authorization: Bearer`, and revocable individually. No JWTs in
the pilot: revocation and audit are simpler with a lookup.

**Scopes** (granted per token at issue time):

| Scope | Allows |
|---|---|
| `query` | read protocols, run queries, read own receipts |
| `submit` | submit runs, preview contributions |
| `publish` | challenges, outcome reports, withdrawals |

**Running a test is not a cloud scope.** Execution is authorized only by the
local policy file `~/.iwik/policy.json` (allowed targets, budget per plan,
`allow_execution`, `allow_disruptive`), read by the runner and never by the
service. The service can propose a plan; it cannot execute one.

**MCP adapter.** `iwik mcp` starts a stdio MCP server inside the runner CLI.
It exposes the tools in the `agent-tools` contract. Each tool maps to exactly
one `member-api` call or one local runner action. There is **no hosted MCP
endpoint** in the pilot: the transport stays local, so the cloud never opens a
channel into a member environment.

**Draft-then-confirm for anything paid or shared.** `submit_run` requires a
`preview_id` from a prior `preview_contribution` whose content digest still
matches. `run_test` requires a `plan_id` from `plan_test` and is denied unless
local policy allows it, returning the exact `iwik run` command for the operator
otherwise.

**Node signing.** Each node holds an Ed25519 key; submissions are signed over
the canonical (JCS) run body. The signature proves which node submitted,
nothing about the target's truthfulness (brief §7).

## Alternatives considered

- **Hosted MCP over HTTP.** More convenient for remote agents, but it is
  exactly the cloud-to-member channel the brief prohibits. Can be revisited for
  query-only tools once the console has real users.
- **JWT with scopes.** Standard, but revocation requires a denylist anyway.
- **A custom agent framework or A2A transport.** Deferred per the brief.

## Consequences

- Agents need the runner installed locally to participate, which is the
  intended shape (the runner also holds the vault and the policy).
- Two artifacts to secure on a node: the token and the signing key. Both live
  under `~/.iwik/` with `0600` permissions; rotation is an SRE stage.
- The tool surface is a frozen contract; adding tools is additive, renaming
  is a new contract.
