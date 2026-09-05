# Contract: evidence-envelope

- **Status:** frozen v1
- **Owner:** `packages/contracts` (schemas generated per ADR-0005 into `contracts/schema/v1/`)

The shared record shapes every component exchanges. Domain-specific fields
never appear inline; they live in pack schemas referenced by digest
(`runner-pack` contract). This contract encodes requirements R2, R3, R4, R7,
R8 of the brief.

## Exposes

JSON Schema (draft 2020-12) for these entities, plus TypeScript types:

| Entity | Purpose |
|---|---|
| `ProtocolVersion` | immutable procedure identity: ref, digest, harness digest, required context, permitted claims, compatibility rules |
| `Run` | one execution of one protocol from one node, with honest accounting |
| `ContextProfile` / `ContextField` | typed context with origin and uncertainty per field |
| `ArtifactCommitment` | digest + access policy for evidence retained locally |
| `Investigation` | question, requested context, priorities, registered thresholds, planned measurements |
| `Claim` | assertion with derivation, supporting runs, status, uncertainty, limitations |
| `Relationship` | supports / contradicts / reproduces / narrows / supersedes, with rationale |
| `AnswerReceipt` | query, cohort description, calculation and policy versions, released result, evidence revision |
| `Challenge` | target, structured grounds, evaluation method, resolution |
| `Outcome` | prediction target, horizon, evaluation rule recorded before the outcome, then the observation |

## Consumes

Nothing. This is the root contract; `member-api`, `runner-pack`, and
`agent-tools` all build on it.

## Schema / wire

Identifiers are ULIDs unless stated. Timestamps are RFC 3339 UTC. Digests are
`sha256:<hex>`. Canonicalization for signing is JCS (RFC 8785).

### ProtocolVersion

```jsonc
{
  "ref": "inference-api/latency@1",        // <pack>/<protocol>@<major>
  "protocol_digest": "sha256:…",           // over protocol.json
  "harness_digest": "sha256:…",            // over the pack's harness/ tree
  "status": "draft|reviewed|accepted|superseded|deprecated",
  "kind": "controlled|observational",      // sampling method survives ingestion
  "required_context": ["model.reported", "concurrency", "retry_policy", "cache_disabled"],
  "permitted_claims": ["latency_distribution", "error_rate"],
  "compatibility": { "harness_digests": ["sha256:…"], "notes": "…" },
  "context_schema_digest": "sha256:…",
  "result_schema_digest": "sha256:…"
}
```

### Run

```jsonc
{
  "run_id": "01J…",
  "attempt_id": "01J…",                    // new per retry of the same planned run
  "org_ref": "opaque",                     // set by intake, absent on the wire from the node
  "node_id": "01J…",
  "protocol_ref": "inference-api/latency@1",
  "protocol_digest": "sha256:…",
  "harness_digest": "sha256:…",
  "investigation_id": "01J…",              // optional
  "started_at": "…", "ended_at": "…",
  "target": { "kind": "service|fixture|device", "label_digest": "sha256:…" },
  "execution_status": "attempted|succeeded|failed|excluded|unobserved",
  "exclusion_reason": "…",                 // REQUIRED when excluded
  "accounting": { "planned": 200, "attempted": 200, "succeeded": 194, "failed": 6, "excluded": 0, "unobserved": 0 },
  "context": { /* ContextProfile */ },
  "result": { /* validated against the pack's result schema */ },
  "result_schema_digest": "sha256:…",
  "artifacts": [ /* ArtifactCommitment */ ],
  "origin": "measured|reported|inferred|published",
  "corroboration": "unreplicated|independently_replicated|disputed",
  "submission": { "signed_at": "…", "key_id": "…", "signature": "base64", "sharing_policy": "private|cooperative" }
}
```

Rules: `unobserved` means the collector or target was unreachable and is never
counted as a product failure (R4). `accounting` sums must reconcile with
`planned`. `origin` and `corroboration` are separate fields and neither
substitutes for the other.

### ContextField

```jsonc
{ "key": "concurrency", "value": 8, "unit": null,
  "origin": "measured|provider_reported|operator_reported|unknown",
  "uncertainty": { "kind": "none|range|categorical", "detail": "…" } }
```

A required context key that is absent is emitted as
`{ "key": …, "value": null, "origin": "unknown" }`, never dropped.

### AnswerReceipt

```jsonc
{
  "receipt_id": "01J…",
  "query_digest": "sha256:…",
  "status": "released|suppressed|insufficient_evidence|stale",
  "cohort": { "protocol_ref": "…", "filters": {…}, "orgs": "3-5", "runs": "6-10" },
  "calculation_version": "…", "policy_version": "…", "evidence_revision": 42,
  "result": { /* findings, applicability, distributions, missingness, contradictions, uncertainty, freshness, limitations */ },
  "suppression_reasons": ["min_orgs", "concentration", "differencing"],
  "issued_at": "…"
}
```

A receipt never contains a `run_id`, `node_id`, or `org_ref` that belongs to
another organization.

## Versioning

Frozen at **v1**. Changes are **additive only** — a breaking change is a NEW
contract, not an edit (framework-spec §4.3). Every consumer depends on this shape.
Enums may gain members; fields may be added as optional; nothing is renamed or
removed. Fixtures under `contracts/fixtures/v1/` are the conformance suite.
