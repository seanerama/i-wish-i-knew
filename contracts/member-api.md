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

## Wire details (additive, recorded 2026-09-06 from the stage 2 implementation)

These are the concrete body shapes the service accepts. They are additive to
the endpoint table above and do not change any listed semantics.

- `POST /v1/contributions/preview` body: `{ "run": <Run> }`.
- `POST /v1/runs` body: `{ "preview_id": "<ulid>", "run": <Run> }`.
- **Signing payload** for `Run.submission.signature`: the JCS canonical form of
  the `Run` object with `submission.signature` removed and with no `org_ref`
  member (the node never sends `org_ref`; intake assigns it). The content
  digest bound to a preview is SHA-256 over the same payload.
- Previews expire after 1 hour and are not consumed; a retry with the same
  `preview_id` and identical content returns `200`; an expired preview returns
  `409 preview_expired`.
- Intake additionally requires: `protocol_digest`, `harness_digest`, and
  `result_schema_digest` match the registry; the protocol status is
  `accepted`; `node_id` equals the token's node; a wire `org_ref` is rejected
  with rule `server_assigned`.
- Validation detail paths are JSON Pointers, with one documented exception:
  `required_context_missing` uses the pseudo-pointer `/context/<key>` naming the
  registry key, because context is an array.

## Operator endpoints (additive, recorded 2026-09-06 from the stage 6 implementation)

| Method and path | Scope | Purpose |
|---|---|---|
| `POST /v1/admin/organizations` | operator (`IWIK_OPERATOR_TOKEN`, not a node token) | create an organization and its one-time enrollment invite; returns the invite URL once; `409` if the display name exists |
| `POST /v1/admin/organizations/{org_id}/invites` | operator | (recorded from stage 11) re-invite an existing organization: returns a one-time invite URL with `kind: "reset"` (console password reset, nodes and tokens kept) or `kind: "enroll"` if the organization never completed enrollment; `404` unknown org; `409 invite_exists` while any unexpired invite is open |

Operator scope is distinct from node scopes and never grants evidence access.
Console routes (`/enroll/<invite>`, `/org`, `/console/login`) are server-rendered
member surfaces behind `IWIK_FEATURE_ENROLLMENT` and are not part of the JSON API.

## Node identity endpoint (additive, recorded 2026-09-06 after the stage 3 review)

| Method and path | Scope | Purpose |
|---|---|---|
| `GET /v1/whoami` | any valid node token | returns `{ "node_id": "<ulid>", "org_display_name": "<string>", "scopes": ["query", …] }` so a runner can learn its own node id without operator input; never returns `org_ref` |

## Withdrawal wire details (additive, recorded 2026-09-06 from stage 7)

- `POST /v1/withdrawals` body: `{ "run_ids": ["<ulid>", …], "reason_code": "member_request|data_error|policy_change" }` (max 100 ids). Response `201 { withdrawal_id, effective_revision }`; the identical sorted set again returns `200` with the same `withdrawal_id`. Any id not owned by the caller → `404 not_found` with no indication which.
- When `IWIK_FEATURE_WITHDRAWAL` is off the endpoint answers `404` with error code `feature_disabled`.
- `GET /v1/runs/{run_id}` additionally returns `withdrawn_at` and `withdrawn_revision` (null until withdrawn) and `sharing_policy`.
- Receipt staleness: a `query`-kind receipt reads `status: "stale"` once any later evidence revision has affected its `protocol_ref` (new intake or withdrawal). Intake receipts never go stale.

## Versioning

Frozen at **v1**. Changes are **additive only** — a breaking change is a NEW
contract, not an edit (framework-spec §4.3). Every consumer depends on this shape.
New endpoints and optional fields may be added under `/v1`; changed semantics
go under `/v2` with a new contract document.
