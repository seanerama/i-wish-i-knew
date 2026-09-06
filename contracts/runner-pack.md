# Contract: runner-pack

- **Status:** frozen v1
- **Owner:** `packages/runner`

The interface between the `iwik` runner and a domain pack. A pack is data plus
a harness; the runner is the only thing that executes it, under local policy.

## Exposes

A pack is a directory with this layout:

```
packs/<pack-id>/
  pack.json                         # { id, version, protocols: [ "<name>@<major>" ] }
  protocols/<name>/protocol.json    # ProtocolVersion (evidence-envelope)
  protocols/<name>/context.schema.json
  protocols/<name>/result.schema.json
  protocols/<name>/claims.json      # permitted claims and their derivation rules
  harness/                          # executable; entry is harness/index.js (Node) in v1
  fixtures/                         # example inputs, expected outputs, stub targets
```

**Pack digest** = `sha256` over the sorted list of `(relative path, file sha256)`
pairs. **Harness digest** = the same over `harness/` only. The runner refuses
to execute a pack whose harness digest is not listed in the registry's
`ProtocolVersion.compatibility.harness_digests`.

## Consumes

- `evidence-envelope` v1 for `ProtocolVersion` and `Run`.
- The local policy file `~/.iwik/policy.json` (ADR-0006) for targets, budgets,
  and execution permission. Packs never read it.

## Schema / wire

**Invocation.** The runner spawns `node harness/index.js` as a child process with:

| Env var | Meaning |
|---|---|
| `IWIK_INPUT` | path to `input.json`: `{ plan_id, protocol_ref, target, context (operator-supplied), budget, timeout_ms }` |
| `IWIK_OUTPUT` | writable directory; harness writes `result.json`, `attempts.jsonl`, optional artifacts |
| `IWIK_ALLOWED_HOSTS` | comma-separated hosts the harness may contact; the runner's egress guard enforces it |

The harness has no network access except the allowed hosts, no access to the
vault, and no credentials beyond what `input.json` carries for the target.

**Outputs.**

- `result.json` validated against `result.schema.json`.
- `attempts.jsonl`: one line per planned attempt, `{ attempt_index, status: "succeeded|failed|excluded|unobserved", reason?, timing }`. The runner derives `Run.accounting` from this file; a harness cannot report success without attempts to back it.
- `context.json` (optional): harness-measured context fields with `origin = measured`.

**Exit codes.**

| Code | Meaning | Resulting `execution_status` |
|---|---|---|
| `0` | completed (failed attempts are still a completed run) | `succeeded` |
| `2` | protocol violated (harness could not honour the procedure) | `excluded`, reason from stderr first line |
| `3` | target unreachable before any attempt | `unobserved` |
| other | harness crashed | `failed` |

**Vault.** The runner writes the full `Run`, harness stdout/stderr, and
artifacts to `~/.iwik/vault/<run_id>/`; only the sanitized `Run` is ever
submitted, and only after `iwik preview` succeeds.

## Cost model and claim derivation (additive, recorded 2026-09-06 from stage 5)

`protocols/<name>/claims.json` may carry two optional members:

- `cost_model`: how the runner estimates a plan's cost. For `target.kind = fixture`
  the estimate is 0. For real targets the estimate is per-request price × planned
  requests, using operator-entered prices; a real target with no estimate is
  refused (fail closed) and any estimate above `budget_per_plan_usd` is refused.
- `derivation.metrics`: JSON Pointers into `result.json` naming the metrics each
  permitted claim is derived from; `iwik report` follows these when summarizing.

## Versioning

Frozen at **v1**. Changes are **additive only** — a breaking change is a NEW
contract, not an edit (framework-spec §4.3). Every consumer depends on this shape.
New env vars and optional output files may be added; the entrypoint, exit-code
table, and digest rules are fixed. A non-Node harness runtime is a v2 contract.
