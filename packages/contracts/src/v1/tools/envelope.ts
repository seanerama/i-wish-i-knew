// The common output envelope of every agent tool (contracts/agent-tools.md
// "Schema / wire"):
//
//   { "ok": true,  "data": { ... } }
//   { "ok": false, "error": { "code", "message", "next_step" } }
//
// `next_step` is human-actionable text (for example the exact CLI command an
// operator must run). Error messages never include private field values.
// The root keeps `type: object` with the `ok` discriminator because an MCP
// tool definition requires an object schema at the root.
import { Type } from '@sinclair/typebox';
import type { Static, TSchema } from '@sinclair/typebox';

export const ToolError = Type.Object(
  {
    code: Type.String({
      minLength: 1,
      pattern: '^[a-z][a-z0-9_]*$',
      description:
        'Machine-readable code: policy_denied, scope_required, suppressed, insufficient_evidence, validation_failed, not_yet_available, ...',
    }),
    message: Type.String({ description: 'Never includes private field values' }),
    next_step: Type.Optional(
      Type.String({ description: 'Human-actionable text, e.g. the exact CLI command to run' }),
    ),
  },
  { additionalProperties: false },
);
export type ToolError = Static<typeof ToolError>;

export const ToolErrorEnvelope = Type.Object(
  { ok: Type.Literal(false), error: ToolError },
  { additionalProperties: false },
);
export type ToolErrorEnvelope = Static<typeof ToolErrorEnvelope>;

export function toolOkEnvelope<T extends TSchema>(data: T) {
  return Type.Object({ ok: Type.Literal(true), data }, { additionalProperties: false });
}

/** `{ ok: true, data } | { ok: false, error }` as one object schema. */
export function toolOutput<T extends TSchema>(data: T, description: string) {
  return Type.Unsafe<{ ok: true; data: Static<T> } | ToolErrorEnvelope>({
    type: 'object',
    description,
    required: ['ok'],
    properties: { ok: Type.Boolean() },
    oneOf: [toolOkEnvelope(data), ToolErrorEnvelope],
  });
}
