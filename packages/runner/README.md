# i-wish-i-knew (`iwik`) — the runner

The member half of the spine (stage 3, `docs/walking-skeleton.md`) plus the
local investigation surface (stage 5): an operator, or an agent through the
MCP adapter, plans and runs one protocol against a target under local policy;
the raw evidence stays in the vault; a local report states its own limits; and
only the sanitized, signed `Run` reaches the service, only after an explicit
preview. Contracts: `contracts/runner-pack.md` (pack layout, env vars, exit
codes, digests), `contracts/member-api.md` (preview/submit wire shapes, signing
payload, `whoami`, `evidence/query`), `contracts/agent-tools.md` (the ten
tools), ADR-0006 (policy, scopes, node signing, the stdio-only MCP adapter).

Published as `i-wish-i-knew` with the `iwik` binary; the same package is the
programmatic API `@iwik/runner` (`plan`, `run`, `runPlan`, `report`, `preview`,
`submit`, `receipt`, `callTool`, plus `init`, policy and vault helpers).
Dependencies: `commander`, `@modelcontextprotocol/sdk` (pinned; stdio server
only), Node built-ins (crypto, http via `fetch`, child_process);
`@iwik/contracts` for schemas, JCS, and the shared digest code; `ajv` for pack
schemas and the report schema.

## Home directory

`IWIK_HOME` (default `~/.iwik`), created 0700 by `iwik init`:

| Path                | Mode | Content                                                                              |
| ------------------- | ---- | ------------------------------------------------------------------------------------ |
| `config.json`       | 0600 | `service_url`, `node_id`, optional `packs_dir`                                       |
| `token`             | 0600 | the node token (copied from `--token-file`); never printed                           |
| `key.ed25519`       | 0600 | Ed25519 private key, PKCS#8 PEM; generated once, never printed                       |
| `policy.json`       | 0600 | local execution policy (below)                                                       |
| `vault/<run_id>/`   | 0700 | one directory per run (below)                                                        |
| `plans/<plan_id>.json` | 0600 | one saved plan per `iwik plan` / `plan_test` (below)                              |

`--home <dir>` on any command overrides `IWIK_HOME`.

## Commands

```
iwik init --service <url> [--token-file <path>] [--node-id <ulid>] [--packs-dir <dir>] [--offline]
iwik policy show
iwik policy set allow_execution true|false      # also allow_disruptive, budget_per_plan_usd
iwik policy allow-target <host|host:port|origin>
iwik policy deny-target <host>
iwik plan --protocol <ref> --target <url> --question "<text>" [--context k=v ...]
          [--target-kind service|fixture|device] [--planned N] [--max-tokens N] [--timeout-ms N]
          [--price <name>=<usd> ...] [--api-key-env <VAR>] [--investigation <ulid>]
          [--share private|cooperative] [--packs-dir <dir>] [--json]
iwik run --plan <plan_id> [--offline] [--manifest <file>] [--packs-dir <dir>]
iwik run --protocol <ref> --target <url> [--planned N] [--context k=v ...]
         [--target-kind service|fixture|device] [--share private|cooperative]
         [--model <name>] [--api-key-env <VAR>] [--timeout-ms N] [--max-tokens N]
         [--price <name>=<usd> ...] [--investigation <ulid>] [--offline] [--manifest <file>] [--packs-dir <dir>]
iwik report <run_id> | --protocol <ref>  [--json] [--packs-dir <dir>]
iwik preview <run_id> [--share private|cooperative]
iwik submit <run_id>
iwik receipt <id>
iwik withdraw <run_id...> --reason member_request|data_error|policy_change   # needs IWIK_FEATURE_WITHDRAWAL=on on the service
iwik vault
iwik plans <plan_id>
iwik mcp [--packs-dir <dir>]                     # needs IWIK_MCP_ENABLED=on
```

- `init` prints the node's public key (base64 of the raw 32 bytes, the form
  enrollment and the service's `IWIK_SEED_NODE_PUBKEY` accept) on stdout,
  followed on stderr by the enrollment instructions of the console's `/org`
  page (register the node with that key; a PEM SPKI block is accepted at
  registration but is never what `iwik init` prints; issue a scoped token;
  revoke when lost), and nothing secret anywhere. When a token is available
  and `--node-id` is not given, it calls `GET /v1/whoami` and stores the node
  id it learns (with the organization's display name and the token's scopes on
  stderr); `--node-id` sets it offline, `--offline` skips the call. Re-running
  it keeps the key, the token, and the policy and merges the config.
- `plan` prints the `plan_id` on stdout (the plan summary as JSON with
  `--json`) and, on stderr, the estimated cost, the required context still
  unknown, what the test resolves, and whether policy would allow it, with the
  exact `iwik run --plan` command. It never executes anything and never
  contacts the service.
- `run` prints the `run_id` on stdout and a one-line summary on stderr (plus
  the vault-only exclusion detail, the estimate, and `iwik report <run_id>`).
- `report` prints Markdown (JSON with `--json`) whose first line is the fixed
  header `Local evidence only — not corroborated by the cooperative`.
- `preview` prints the sanitization report and the exact body `submit` will
  send. `submit` prints the receipt. `receipt` prints a receipt (intake or
  query; a query receipt reads `stale` once a later evidence revision touched
  its protocol). `withdraw` asks the service to withdraw your organization's
  runs (stage 7): only ids and the reason code cross the wire, the withdrawal
  is one evidence-revision increment, the same set is the same withdrawal, and
  a set with any run that is not yours is `not_found` as a whole (exit `5`); it
  prints the withdrawal id. `plans` prints a saved plan with the runs executed
  from it.
- Every failure exits nonzero with one line `iwik: <code>: <reason>` on
  stderr: `2` usage, `3` policy and budget denial (`policy_denied`,
  `target_not_allowed`, `budget_unknown`, `budget_exceeded`, `feature_disabled`),
  `4` pack/digest problems (`harness_digest_mismatch`, `protocol_digest_mismatch`,
  `pack_digest_mismatch`, `protocol_not_accepted`, ...), `5` service errors
  (the service's error code and `{ path, rule }` details, never values), `6`
  vault and plan state (`preview_required`, `preview_expired`, `run_not_found`,
  `plan_not_found`, `plan_invalid`, `report_empty`), `7` home state
  (`not_initialized`).

## Policy (kill switch) and budget

`policy.json` defaults to

```json
{ "allow_execution": false, "allowed_targets": [], "budget_per_plan_usd": 0, "allow_disruptive": false }
```

`iwik run` refuses unless `allow_execution` is `true` **and** the target's
host (`hostname` or `hostname:port`; an origin like `https://api.example.test:8443`
is reduced to its host) is listed in `allowed_targets`. A denied run never
reads the pack, never contacts the registry, never spawns a harness, and never
writes to the vault. A missing policy file is the default policy; a malformed
one is an error, never a permissive default.

**Budget (ADR-0003).** Every run, planned or direct, is priced from the pack's
`claims.json` `cost_model` before the harness starts, and refused with
`budget_exceeded` when the estimate exceeds `budget_per_plan_usd`. A target the
model cannot price is refused with `budget_unknown` (fail closed): a missing
estimate is never treated as free. The `inference-api/latency@1` model prices
`fixture` targets at 0 per request and prices any other target from two
operator-supplied numbers, `usd_per_1m_prompt_tokens` and
`usd_per_1m_completion_tokens` (`--price name=usd`, repeatable), as an upper
bound: `planned * (prompt_tokens_per_request * prompt price + max_tokens *
completion price) / 1e6`. The accepted estimate is recorded in `vault.json`.
`allow_disruptive` is recorded; no pack declares a disruptive procedure yet.

`submit` is off until a preview exists: it refuses with `preview_required`.

## Plans

`iwik plan` (and the `plan_test` tool) writes `plans/<plan_id>.json`: the
protocol and its digest, the target (URL and kind), the question, the
operator-supplied context, the required context split into `known` and
`unknown` (unknown keys are listed, never invented; unless the harness
measures them the run is `excluded`), `planned` / `max_tokens` /
`timeout_ms`, the sharing policy, the `estimated_cost` (`amount` is `null`
when the model cannot price the target), `resolves` (the permitted claims and
a plain statement of what one local, unreplicated run does and does not
settle), and `execution` (whether policy allows it now, why not, and the exact
`iwik run --plan <id>` command with the policy steps the operator must take
first). The record also keeps the prices, the API-key variable **name**, and
the runs executed from it. `iwik run --plan <id>` takes every parameter from
the file, passes the `plan_id` to the harness in `input.json`, and appends the
run to the plan's `runs`.

## What `iwik run` does

1. Loads the policy and checks the target (above).
2. Loads the pack from `packs_dir` (`--packs-dir`, `IWIK_PACKS_DIR`,
   `config.json`, or the repository's `packs/` in development) and recomputes
   every digest from the files with the shared code in `@iwik/contracts`
   (`computePackDigests`): harness tree digest, protocol digest, schema digests,
   pack digest.
3. Fetches the registry's `ProtocolVersion` from `GET /v1/protocols/{ref}`
   (or, with `--offline`, uses the pack's own `protocol.json`; with
   `--manifest <file>`, a saved registry body) and refuses unless the local
   harness digest is listed in `compatibility.harness_digests`, the protocol,
   result-schema and context-schema digests match, the pack digest matches when
   the registry supplies one, and the protocol status is `accepted`.
4. Prices the run from the pack's cost model and checks the budget (above).
5. Creates a private work directory **outside the vault** (`mkdtemp` under the
   OS temp dir, 0700; `IWIK_WORK_DIR` overrides the base) and spawns
   `node harness/index.js` with `IWIK_INPUT`, `IWIK_OUTPUT`, and
   `IWIK_EGRESS_LOG` pointing into it, `IWIK_ALLOWED_HOSTS` (the target host
   only), and `NODE_OPTIONS=--require guard/egress-guard.cjs`. The child gets a
   minimal environment (PATH and temp-dir variables), never the runner's, and
   never learns where the vault is, so it cannot read sibling runs. A target API
   key is taken from the environment variable named by `--api-key-env`, written
   only to the work directory's `input.json`, and never to the vault.
6. After the harness exits, moves `attempts.jsonl`, `result.json`, and
   `context.json` into the vault entry, copies anything else it wrote into
   `output/`, keeps the egress log, writes the credential-free `input.json`,
   and deletes the work directory.
7. Derives `accounting` from `attempts.jsonl`, maps the exit code
   (`0` succeeded, `2` excluded, `3` unobserved, anything else failed; a kill
   after the overall timeout is failed), validates `result.json` against the
   pack's `result.schema.json`, merges context (below), and assembles the `Run`.
8. Writes the vault entry and prints the run id.

A harness that exits `0` cannot report success on its own: fewer or more
attempt lines than planned, an invalid `result.json`, a required context key
nobody supplied, or a context projection the pack's `context.schema.json`
rejects all make the run `excluded`. Attempts the harness never reported are
counted as `excluded` for excluded/succeeded-turned-excluded runs and as
`unobserved` for unreachable, crashed, or killed harnesses, so `accounting`
always reconciles.

### Exclusion reasons on the wire

`Run.exclusion_reason` is one of a fixed vocabulary, and nothing else ever
reaches the service: `egress_denied`, `harness_protocol_violation`,
`attempt_count_mismatch`, `result_schema_invalid`, `required_context_unknown`,
`context_schema_violation`. The specific detail (the host the harness tried to
reach, the harness's stderr line, the missing key names, the schema path) is
`exclusion_detail` in `vault.json` and in the CLI output, vault-only.

### Context merge (operator vs harness)

`--context k=v` fields carry `origin = operator_reported` (values are typed:
`true`/`false` become booleans, numeric text a number, `null` null, anything
else a string). The harness's optional `context.json` carries what it measured.
For the same key, a harness field with `origin = measured` or `provider_reported`
**wins** over the operator's value, and the override is logged in
`vault.json` (`context_overrides: [{ key, operator_value, harness_value,
harness_origin }]`) and echoed by the CLI. A harness field with any other
origin does not override an operator value. A required key (from the
registry's `required_context`) missing from both sides is emitted as
`{ "key": …, "value": null, "origin": "unknown" }`, never dropped; per the
pack's context schema such a run is `excluded`, not defaulted. Required keys
come first in the protocol's order, then the rest sorted by key.

### The vault

`vault/<run_id>/` (directory 0700, every file 0600; harness outputs are
re-chmodded after the run):

| File                                          | Written by | Content                                                                                                      |
| --------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| `run.draft.json`                              | `run`      | the assembled `Run` **without** `submission`, plus the vault-only `target.label` (the target origin)          |
| `run.json`                                    | `preview`  | the signed, sanitized `Run` exactly as previewed and submitted                                                |
| `preview.json`                                | `preview`  | `preview_id`, `content_digest`, `expires_at`, sanitization report                                             |
| `receipt.json`                                | `submit`   | the intake receipt                                                                                            |
| `vault.json`                                  | `run`      | runner metadata: plan id, estimate, harness exit/signal/timeout, `exclusion_detail`, overrides, unknown keys, egress violations, notes |
| `input.json`                                  | `run`      | what the harness was given, without the credential                                                            |
| `stdout`, `stderr`                            | `run`      | harness output                                                                                                |
| `attempts.jsonl`, `result.json`, `context.json` | harness  | moved in from the work directory                                                                              |
| `output/`                                     | harness    | anything else the harness wrote                                                                               |
| `egress.jsonl`                                | guard      | one JSON line per denied connection                                                                           |

`Run.submission` is required by the frozen schema, and a run cannot be signed
before it exists, so the pre-signature representation lives under
`run.draft.json`; `run.json` is only ever a complete, valid, signed `Run`.
`target.label` never leaves the vault: the wire carries `target.label_digest`
(SHA-256 over the JCS form of the label string).

## Local report

`iwik report <run_id>` or `iwik report --protocol <ref>` reads the vault
(never the service) and prints, under the fixed header **Local evidence only —
not corroborated by the cooperative**: a table of runs with status, exclusion
reason, accounting, target kind, and submission state; the accounting across
runs and attempts; one section per claim the protocol permits, derived from
the pack's `claims.json` (`derivation.metrics`: JSON pointers into
`result.json`, of kind `distribution`, `rate`, or `breakdown`), showing each
eligible run's value and the **spread across runs** (min, median, max per
percentile), never a pooled number, with runs below the claim's per-run
minimum listed separately; the required context keys unknown per run; and
limitations (one node, unreplicated; fixture targets are never releasable;
non-succeeded runs count in accounting only). Only `succeeded` runs feed a
claim. The JSON form (`--json`) validates against
`schema/local-report.schema.json` before it is printed. Nothing in the report
names the target.

## Preview and submit

`preview` reads the draft, drops `target.label`, attaches `submission`
(`signed_at`, `key_id = ed25519:<16 hex of sha256(public key)>`, the requested
`sharing_policy`), signs the JCS canonical form of the `Run` without
`submission.signature` and without `org_ref` (the `member-api` signing
payload), validates it against the `Run` schema, and posts `{ run }` to
`POST /v1/contributions/preview`. It checks that the service's `content_digest`
equals the local one, then stores `preview.json` and `run.json`. `signed_at`
is reused from the previous preview only while the unsigned body is unchanged
(same digest as `preview.json` records), so re-previewing an unchanged draft
yields the same digest and signature and a resubmission stays the idempotent
`200`; a changed draft or sharing policy is signed at a fresh time.

`submit` refuses without `preview.json` and `run.json`, refuses locally when
the preview has expired (the service answers `409 preview_expired` as well),
posts `{ preview_id, run }` to `POST /v1/runs` with the stored body byte for
byte, stores the receipt, and reports `201` (accepted) or `200` (already
accepted, same receipt). A `run.json` edited after preview is answered by the
service with `409 preview_mismatch`; the runner surfaces the service's code
and details and stores nothing.

## Egress guard (best effort)

`guard/egress-guard.cjs` is a Node preload. It patches
`net.Socket.prototype.connect` (the chokepoint for `http`, `https`, `tls`,
undici's `fetch`, and raw sockets) and `globalThis.fetch` (early rejection),
and closes the routes that would bypass the patched prototype: `child_process`
and `worker_threads.Worker` (a subprocess or worker would not inherit the
patches), `dgram` (UDP never touches `net.Socket`), and `process.binding` /
`process._linkedBinding` access to `tcp_wrap`, `pipe_wrap`, and `udp_wrap`
(raw handles). A connection to a host outside `IWIK_ALLOWED_HOSTS` (`host` or
`host:port` entries; the runner sets the target host only) fails with an
`IWIK_EGRESS_DENIED` error, is appended to `egress.jsonl`, and is printed on
stderr. Any denial makes the run `excluded` with reason `egress_denied`
regardless of the harness exit code; the host goes to `exclusion_detail`. The
guard fails closed: if it cannot install, the harness exits `2` before running.

This is a **best-effort guard for Node harnesses in v1**. It runs inside the
harness process, which could in principle undo the patches; it does not cover
DNS lookups as such or non-Node harnesses (a non-Node runtime is a v2
`runner-pack` contract). A process-level sandbox is a later security/SRE stage.

## MCP adapter (`iwik mcp`)

`iwik mcp` serves the ten tools of `contracts/agent-tools.md` over stdio with
`@modelcontextprotocol/sdk` (`Server` + `StdioServerTransport`; there is no
hosted endpoint, ADR-0006). Each tool's `inputSchema` and `outputSchema` are
the committed `contracts/schema/v1/tools/<tool>.<input|output>.schema.json`
verbatim; the runner validates every input and output against them, and every
answer is the envelope `{ ok: true, data }` or `{ ok: false, error: { code,
message, next_step } }` — never a thrown error, never a private value.
`SKILL.md` (shipped with the package) is handed to the client as the server's
instructions.

| Tool                   | What it does                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `get_protocol`         | `GET /v1/protocols/{ref}`                                                                                                        |
| `query_evidence`       | `POST /v1/evidence/query`; a non-released receipt is `ok: false` with its status as the code (`insufficient_evidence`, ...) and a next step |
| `plan_test`            | `iwik plan`; returns the plan summary                                                                                            |
| `run_test`             | `iwik run --plan`; **denied by default**: `policy_denied` / `target_not_allowed` / `budget_*` with the exact operator command in `next_step` |
| `preview_contribution` | `iwik preview`; returns the sanitization report and the exact `run` that would be sent                                            |
| `submit_run`           | `iwik submit`; refuses without a preview                                                                                         |
| `get_receipt`          | `GET /v1/receipts/{id}` (intake or query receipts)                                                                               |
| `withdraw_contribution` | `iwik withdraw`; `run_ids` plus a `reason_code` (`member_request`, `data_error`, `policy_change`; the legacy free-text `reason` is never sent); returns `withdrawal_id` and `effective_revision`; `feature_disabled` with a next step when the deployment has `IWIK_FEATURE_WITHDRAWAL` off |
| `challenge_finding`, `report_outcome` | present and frozen; answer `not_yet_available` with a `next_step` naming milestone 0.3 stage 10             |

**Dark-launch flag:** `IWIK_MCP_ENABLED` (default off). Without it `iwik mcp`
exits `3` with `feature_disabled` and says why. Attach to Claude Code with
`claude mcp add iwik --env IWIK_MCP_ENABLED=on -- node packages/runner/bin/iwik.cjs mcp`
(see `smoke/mcp.md`).

## Programmatic API

```ts
import { init, plan, runPlan, report, preview, submit, receipt, savePolicy, callTool } from '@iwik/runner';

init({ home, serviceUrl, tokenFile });            // then discoverNode(home) for the node id
const p = plan({ home, protocol: 'inference-api/latency@1', target: 'http://127.0.0.1:8089', targetKind: 'fixture', question: 'how fast?', context: ['model.requested=stub-model', 'concurrency=1', 'cache_disabled=true', 'client_region=local'], planned: 20 });
savePolicy(home, { allow_execution: true, allowed_targets: ['127.0.0.1:8089'], budget_per_plan_usd: 0, allow_disruptive: false });
const r = await runPlan(p.plan_id, { home });
const local = report({ home, runId: r.run_id });   // local.header is the fixed local-only line
const pv = await preview(r.run_id, { home });      // pv.body is exactly what submit sends
const s = await submit(r.run_id, { home });        // s.status 201 | 200, s.receipt
const again = await receipt(String(s.receipt.receipt_id), { home });
const envelope = await callTool('run_test', { plan_id: p.plan_id }, { home });
```

Errors are `RunnerError` (`code`, `exitCode`, `details`) or `ApiError`
(`status`, `apiCode`, `details`, `body`). Options accept `fetch` and `env`
overrides for tests.

## Tests

`npm test -w i-wish-i-knew` (no database needed): policy denial and allowlist
without a harness spawn, harness-digest and registry-manifest mismatches, the
egress guard blocking http/fetch/raw-socket/subprocess/worker/UDP/`tcp_wrap`
exfiltration with the run `excluded`, the harness working outside the vault
and unable to see sibling runs, no hostname or harness stderr on the wire,
exit-code mapping, accounting reconciliation, the context merge precedence,
vault permissions, API-key scrubbing, the cost model and budget (unpriced
refused, over budget refused, within budget runs), plans and `iwik run --plan`,
the local report (header, schema, claims, Markdown), `signed_at` reuse rules,
`GET /v1/whoami` in `iwik init`, `SKILL.md` lint, and the MCP adapter through
the SDK client (the ten tools with the committed schemas verbatim, the
kill-switch, `plan_test` → `run_test` denied → policy → `run_test` →
`preview_contribution` → `submit_run` → `get_receipt`, `query_evidence` →
`insufficient_evidence`, `withdraw_contribution`, the two `not_yet_available`
tools) against an
in-process mirror of the member-api. The full walking skeleton against the
real service and PostgreSQL lives in `packages/service/test/spine.test.ts`.
