# 0005. Contracts as JSON Schema generated from TypeBox

- **Status:** Accepted
- **Date:** 2026-09-05

## Context

The brief names JSON Schema as the candidate exchange contract (§5) and requires
that every qualifying run identify an immutable protocol version, harness
version, permitted claims, and measurement method (R2). The Verity
`contracts-first` guide has one hard rule: frozen contracts are additive-only,
and a breaking change is a new contract. Three components (runner, service,
MCP adapter) validate the same shapes; hand-maintained schemas would drift from
the TypeScript types that consume them.

## Decision

- **Source of truth:** `packages/contracts/src/v1/*.ts` defines every envelope
  type with **TypeBox**, which emits JSON Schema draft 2020-12 compatible
  objects and infers TypeScript types from the same declaration.
- **Frozen artifact:** `npm run contracts:build` writes
  `contracts/schema/v1/<Entity>.schema.json`. These files are **committed** and
  a CI gate (`contracts:check`) regenerates and fails on any diff. The committed
  JSON is what external implementers (other runners, other languages) target.
- **Validation everywhere, once each:** the runner validates before submit,
  Fastify validates on intake with the same schema via Ajv, the MCP adapter
  validates tool inputs with the same schema.
- **Additive-only:** new fields are optional with documented defaults; enums
  only grow; nothing is renamed or removed. A breaking change creates
  `contracts/schema/v2/` and a new contract document.
- **Domain fields** (pack-specific context and results) are separate schemas
  shipped in the pack (`runner-pack` contract), referenced by digest from the
  protocol version. The shared envelope never embeds domain fields inline.

## Alternatives considered

- **zod.** Excellent TypeScript ergonomics, but JSON Schema output needs a
  conversion layer and does not round-trip all constraints.
- **Hand-written JSON Schema + generated types.** Works, but the schema and the
  server code that builds responses drift silently.
- **Protobuf / OpenAPI-first.** Poor fit for agent tooling that speaks JSON, and
  OpenAPI is generated *from* the Fastify routes anyway.

## Consequences

- TypeBox is a pinned runtime dependency of all three packages.
- A schema change without regenerating the committed artifacts is a red gate,
  which is the point.
- Non-TypeScript implementers get plain JSON Schema files and a fixtures
  directory to conform against.
