# i-wish-i-knew (`iwik`) — the runner

The member half of the spine (stage 3, `docs/walking-skeleton.md`). A local
operator runs one protocol against a target under local policy; the raw
evidence stays in the vault; only the sanitized, signed `Run` reaches the
service, and only after an explicit preview. Contracts: `contracts/runner-pack.md`
(pack layout, env vars, exit codes, digests), `contracts/member-api.md`
(preview/submit wire shapes, signing payload), ADR-0006 (policy, scopes, node
signing).

Published as `i-wish-i-knew` with the `iwik` binary; the same package is the
programmatic API `@iwik/runner` (`run`, `preview`, `submit`, `receipt`, plus
`init`, policy and vault helpers) that stage 5's MCP adapter and the service's
end-to-end test use. Dependencies: `commander` and Node built-ins (crypto,
http via `fetch`, child_process); `@iwik/contracts` for schemas, JCS, and the
shared digest code; `ajv` for pack schemas.

## Home directory

`IWIK_HOME` (default `~/.iwik`), created 0700 by `iwik init`:

| Path | Mode | Content |
|---|---|---|
| `config.json` | 0600 | `service_url`, `node_id`, optional `packs_dir` |
| `token` | 0600 | the node token (copied from `--token-file`); never printed |
| `key.ed25519` | 0600 | Ed25519 private key, PKCS#8 PEM; generated once, never printed |
| `policy.json` | 0600 | local execution policy (below) |
| `vault/<run_id>/` | 0700 | one directory per run (below) |
| `plans/` | 0700 | reserved for stage 5's `plan_test` |

`--home <dir>` on any command overrides `IWIK_HOME`.

## Commands

```
iwik init --service <url> [--token-file <path>] [--node-id <ulid>] [--packs-dir <dir>]
iwik policy show
iwik policy set allow_execution true|false      # also allow_disruptive, budget_per_plan_usd
iwik policy allow-target <host|host:port|origin>
iwik policy deny-target <host>
iwik run --protocol <ref> --target <url> [--planned N] [--context k=v ...]
         [--target-kind service|fixture|device] [--share private|cooperative]
         [--model <name>] [--api-key-env <VAR>] [--timeout-ms N] [--max-tokens N]
         [--investigation <ulid>] [--offline] [--manifest <file>] [--packs-dir <dir>]
iwik preview <run_id> [--share private|cooperative]
iwik submit <run_id>
iwik receipt <id>
iwik vault
```

- `init` prints the node's public key (base64 of the raw 32 bytes, the form
  enrollment and the service's `IWIK_SEED_NODE_PUBKEY` accept) on stdout and
  nothing secret anywhere. Re-running it keeps the key, the token, and the
  policy and merges the config.
- `run` prints the `run_id` on stdout and a one-line summary on stderr.
- `preview` prints the sanitization report and the exact body `submit` will
  send. `submit` prints the receipt. `receipt` prints a receipt.
- Every failure exits nonzero with one line `iwik: <code>: <reason>` on
  stderr: `2` usage, `3` policy denial (`policy_denied`, `target_not_allowed`),
  `4` pack/digest problems (`harness_digest_mismatch`, `protocol_digest_mismatch`,
  `pack_digest_mismatch`, `protocol_not_accepted`, ...), `5` service errors
  (the service's error code and `{ path, rule }` details, never values), `6`
  vault state (`preview_required`, `preview_expired`, `run_not_found`), `7`
  home state (`not_initialized`).

## Policy (kill switch)

`policy.json` defaults to

```json
{ "allow_execution": false, "allowed_targets": [], "budget_per_plan_usd": 0, "allow_disruptive": false }
```

`iwik run` refuses unless `allow_execution` is `true` **and** the target's
host (`hostname` or `hostname:port`; an origin like `https://api.example.test:8443`
is reduced to its host) is listed in `allowed_targets`. A denied run never
reads the pack, never contacts the registry, never spawns a harness, and never
writes to the vault. A missing policy file is the default policy; a malformed
one is an error, never a permissive default. `budget_per_plan_usd` and
`allow_disruptive` are recorded for stage 5's planner; no pack declares a cost
model or a disruptive procedure yet, so they are not enforced in v1.

`submit` is off until a preview exists: it refuses with `preview_required`.

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
4. Spawns `node harness/index.js` with `IWIK_INPUT`, `IWIK_OUTPUT`,
   `IWIK_ALLOWED_HOSTS` (the target host only), `IWIK_EGRESS_LOG`, and
   `NODE_OPTIONS=--require guard/egress-guard.cjs`. The child gets a minimal
   environment (PATH and temp-dir variables), never the runner's. A target API
   key is taken from the environment variable named by `--api-key-env`, given
   to the harness in `input.json`, and scrubbed from the vault copy as soon as
   the harness exits.
5. Derives `accounting` from `attempts.jsonl`, maps the exit code
   (`0` succeeded, `2` excluded with the first stderr line as reason, `3`
   unobserved, anything else failed; a kill after the overall timeout is
   failed), validates `result.json` against the pack's `result.schema.json`,
   merges context (below), and assembles the `Run`.
6. Writes the vault entry and prints the run id.

A harness that exits `0` cannot report success on its own: fewer attempt lines
than planned (`attempts_missing`), more than planned (`attempts_exceed_planned`),
an invalid `result.json` (`result_invalid`), a required context key nobody
supplied (`required_context_unknown`), or a context projection the pack's
`context.schema.json` rejects (`context_schema_violation`) all make the run
`excluded` with that reason. Attempts the harness never reported are counted
as `excluded` for excluded/succeeded-turned-excluded runs and as `unobserved`
for unreachable, crashed, or killed harnesses, so `accounting` always
reconciles.

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

| File | Written by | Content |
|---|---|---|
| `run.draft.json` | `run` | the assembled `Run` **without** `submission`, plus the vault-only `target.label` (the target origin) |
| `run.json` | `preview` | the signed, sanitized `Run` exactly as previewed and submitted |
| `preview.json` | `preview` | `preview_id`, `content_digest`, `expires_at`, sanitization report |
| `receipt.json` | `submit` | the intake receipt |
| `vault.json` | `run` | runner metadata: harness exit/signal/timeout, context overrides, unknown keys, egress violations, notes |
| `input.json` | `run` | what the harness was given, credentials removed after the run |
| `stdout`, `stderr` | `run` | harness output |
| `attempts.jsonl`, `result.json`, `context.json` | harness | moved up from `output/` |
| `output/` | harness | anything else the harness wrote |
| `egress.jsonl` | guard | one JSON line per denied connection |

`Run.submission` is required by the frozen schema, and a run cannot be signed
before it exists, so the pre-signature representation lives under
`run.draft.json`; `run.json` is only ever a complete, valid, signed `Run`.
`target.label` never leaves the vault: the wire carries `target.label_digest`
(SHA-256 over the JCS form of the label string).

## Preview and submit

`preview` reads the draft, drops `target.label`, attaches `submission`
(`signed_at`, `key_id = ed25519:<16 hex of sha256(public key)>`, the requested
`sharing_policy`), signs the JCS canonical form of the `Run` without
`submission.signature` and without `org_ref` (the `member-api` signing
payload), validates it against the `Run` schema, and posts `{ run }` to
`POST /v1/contributions/preview`. It checks that the service's `content_digest`
equals the local one, then stores `preview.json` and `run.json`. `signed_at`
is fixed the first time a run is signed and reused by later previews, so
re-previewing an unchanged draft yields the same digest and signature and a
resubmission stays the idempotent `200` instead of a `run_conflict`.

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
undici's `fetch`, and raw sockets), `globalThis.fetch` (early rejection), and
disables `child_process` (a subprocess would not inherit the patches). A
connection to a host outside `IWIK_ALLOWED_HOSTS` (`host` or `host:port`
entries; the runner sets the target host only) fails with an
`IWIK_EGRESS_DENIED` error, is appended to `egress.jsonl`, and is printed on
stderr. Any denial makes the run `excluded` with reason
`egress_violation: harness attempted <host>` regardless of the harness exit
code. The guard fails closed: if it cannot install, the harness exits `2`
before running.

This is a **best-effort guard for Node harnesses in v1**. It runs inside the
harness process, which could in principle undo the patches; it does not cover
UDP, DNS lookups as such, or non-Node harnesses (a non-Node runtime is a v2
`runner-pack` contract). A process-level sandbox is a later security/SRE stage.

## Programmatic API

```ts
import { init, run, preview, submit, receipt, savePolicy } from '@iwik/runner';

init({ home, serviceUrl, tokenFile, nodeId });
savePolicy(home, { allow_execution: true, allowed_targets: ['127.0.0.1:8089'], budget_per_plan_usd: 0, allow_disruptive: false });
const r = await run({ home, protocol: 'inference-api/latency@1', target: 'http://127.0.0.1:8089', planned: 20, targetKind: 'fixture', context: ['model.requested=stub-model', 'concurrency=1', 'cache_disabled=true', 'client_region=local'] });
const p = await preview(r.run_id, { home });   // p.body is exactly what submit sends
const s = await submit(r.run_id, { home });    // s.status 201 | 200, s.receipt
const again = await receipt(String(s.receipt.receipt_id), { home });
```

Errors are `RunnerError` (`code`, `exitCode`, `details`) or `ApiError`
(`status`, `apiCode`, `details`, `body`). Options accept `fetch` and `env`
overrides for tests.

## Tests

`npm test -w i-wish-i-knew` (no database needed): policy denial and allowlist
without a harness spawn, harness-digest and registry-manifest mismatches, the
egress guard blocking http/fetch/raw-socket/subprocess exfiltration with the
run `excluded`, exit-code mapping, accounting reconciliation, the context
merge precedence, vault permissions, API-key scrubbing, and preview/submit
against an in-process mirror of intake (signature verification with the node's
public key, 201/200/409). The full walking skeleton against the real service
and PostgreSQL lives in `packages/service/test/spine.test.ts`.
