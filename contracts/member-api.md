# Contract: member-api

- **Status:** frozen v1
- **Owner:** `packages/service`

The authenticated HTTPS surface between member nodes (runner, MCP adapter,
console) and the cooperative service. Every response obeys the disclosure
policy of ADR-0002; there is no raw-evidence endpoint for other members' data.

## Exposes

Base path `/v1`. JSON request and response bodies validated against
`evidence-envelope` schemas. OpenAPI document served at `/v1/openapi.json`.

| Method and path | Scope | Purpose |
|---|---|---|
| `GET /healthz` | none | liveness |
| `GET /readyz` | none | readiness (database reachable, migrations current) |
| `GET /v1/protocols` | `query` | list accepted protocol versions |
| `GET /v1/protocols/{ref}` | `query` | one `ProtocolVersion`, with pack download pointer and digests |
| `POST /v1/investigations` | `query` | register a question, context, priorities, thresholds; returns `investigation_id` |
| `GET /v1/investigations/{id}` | `query` | own organization only |
| `POST /v1/contributions/preview` | `submit` | dry-run intake: validation result, sanitization report, what would be stored; returns `preview_id` + `content_digest` |
| `POST /v1/runs` | `submit` | submit a signed `Run`; requires matching `preview_id`; idempotent on `run_id` |
| `GET /v1/runs/{run_id}` | `query` | own organization only |
| `POST /v1/evidence/query` | `query` | compatible-cohort query; returns an `AnswerReceipt` (released, suppressed, or insufficient) |
| `GET /v1/receipts/{id}` | `query` | re-read a receipt; status may have become `stale` |
| `POST /v1/challenges` | `publish` | file a structured challenge |
| `POST /v1/outcomes` | `publish` | report an observed outcome against a prior prediction |
| `POST /v1/withdrawals` | `publish` | withdraw own runs; effective at next evidence revision |

## Consumes

- `evidence-envelope` v1 schemas.
- Node tokens and scopes issued by the identity module (ADR-0006).

## Schema / wire

**Auth:** `Authorization: Bearer <node-token>`. Missing or revoked → `401`.
Wrong scope → `403` with `error.code = "scope_required"` and the scope name.

**Idempotency:** `POST /v1/runs` is keyed by `run_id`. Same `run_id` + same
content digest → `200` with the original receipt. Same `run_id` + different
digest → `409 run_conflict`. Retries never create duplicate evidence.

**Preview binding:** `POST /v1/runs` body includes `preview_id`; the server
recomputes the content digest and rejects with `409 preview_mismatch` if it
differs from the preview.

**Error envelope:**

```json
{ "error": { "code": "validation_failed", "message": "…", "details": [ { "path": "/context/3/value", "rule": "secret_pattern" } ] } }
```

Details carry JSON paths and rule names only, never submitted values.

**Query request:**

```jsonc
{ "protocol_ref": "inference-api/latency@1",
  "investigation_id": "01J…",             // optional; thresholds come from here
  "context_filters": { "concurrency": 8, "model.reported": "…" },
  "as_of_revision": 42 }                   // optional; pin a cohort for reproducibility
```

**Rate limits:** `429` with `Retry-After`. Per-token query limits also feed
the repeated-query defense (ADR-0002).

**Pagination:** cursor-based, `?cursor=&limit=`; `limit ≤ 100`.

## Versioning

Frozen at **v1**. Changes are **additive only** — a breaking change is a NEW
contract, not an edit (framework-spec §4.3). Every consumer depends on this shape.
New endpoints and optional fields may be added under `/v1`; changed semantics
go under `/v2` with a new contract document.
