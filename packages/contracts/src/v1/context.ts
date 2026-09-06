// ContextField / ContextProfile — typed context with origin and uncertainty
// per field (contracts/evidence-envelope.md §ContextField).
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { ContextKey, StringEnum } from './common.js';

export const ContextOrigin = StringEnum(
  ['measured', 'provider_reported', 'operator_reported', 'unknown'] as const,
  'How the value was obtained',
);
export type ContextOrigin = Static<typeof ContextOrigin>;

export const UncertaintyKind = StringEnum(['none', 'range', 'categorical'] as const);
export type UncertaintyKind = Static<typeof UncertaintyKind>;

export const Uncertainty = Type.Object(
  {
    kind: UncertaintyKind,
    detail: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type Uncertainty = Static<typeof Uncertainty>;

/** Scalar context values only; a required key that is absent carries `null`. */
export const ContextValue = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
export type ContextValue = Static<typeof ContextValue>;

/**
 * One context field. A required context key that is absent is emitted as
 * `{ key, value: null, origin: "unknown" }`, never dropped.
 */
export const ContextField = Type.Object(
  {
    key: ContextKey,
    value: ContextValue,
    unit: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    origin: ContextOrigin,
    uncertainty: Type.Optional(Uncertainty),
  },
  {
    additionalProperties: false,
    description: 'Typed context field with origin and uncertainty',
  },
);
export type ContextField = Static<typeof ContextField>;

/**
 * The context of a run: an ordered list of fields. Error paths from intake
 * therefore look like `/context/3/value` (contracts/member-api.md).
 */
export const ContextProfile = Type.Array(ContextField, {
  description: 'Context profile: list of ContextField',
});
export type ContextProfile = Static<typeof ContextProfile>;
