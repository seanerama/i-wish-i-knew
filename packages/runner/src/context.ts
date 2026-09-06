// Context assembly: operator-supplied fields (`--context k=v`, origin
// `operator_reported`) merged with the harness's `context.json` (origin
// `measured` or `provider_reported`). Precedence: a harness-measured value
// wins over an operator-supplied value for the same key, and the override is
// logged in the vault; a required key missing from both is emitted as
// `{ value: null, origin: "unknown" }`, never dropped.
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import type { ContextField, ContextValue } from '@iwik/contracts';
import { validate } from '@iwik/contracts';
import { RunnerError } from './errors.js';
import type { ErrorDetail } from './errors.js';

const KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/** `key=value`; `true`/`false` become booleans, numeric text becomes a number, anything else a string. */
export function parseContextArg(arg: string): [string, ContextValue] {
  const eq = arg.indexOf('=');
  if (eq <= 0) throw new RunnerError('context_invalid', `context argument must be key=value`);
  const key = arg.slice(0, eq);
  const raw = arg.slice(eq + 1);
  if (!KEY_PATTERN.test(key)) {
    throw new RunnerError('context_invalid', `context key must be dotted lowercase (${key})`);
  }
  return [key, coerce(raw)];
}

export function coerce(raw: string): ContextValue {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?$/.test(raw)) return Number(raw);
  return raw;
}

export function parseContextArgs(args: readonly string[]): Record<string, ContextValue> {
  const out: Record<string, ContextValue> = {};
  for (const arg of args) {
    const [key, value] = parseContextArg(arg);
    out[key] = value;
  }
  return out;
}

export interface ContextOverride {
  key: string;
  operator_value: ContextValue;
  harness_value: ContextValue;
  harness_origin: ContextField['origin'];
}

export interface MergedContext {
  context: ContextField[];
  overrides: ContextOverride[];
  /** Required keys whose value is null / origin unknown after the merge. */
  unknown: string[];
}

const HARNESS_WINS: ReadonlySet<ContextField['origin']> = new Set([
  'measured',
  'provider_reported',
]);

/** Parse the harness's context.json: an array of ContextField; anything else is ignored with an issue. */
export function parseHarnessContext(value: unknown): { fields: ContextField[]; issues: string[] } {
  const issues: string[] = [];
  const fields: ContextField[] = [];
  if (!Array.isArray(value)) {
    return { fields, issues: ['context.json is not an array'] };
  }
  value.forEach((item, i) => {
    const result = validate('ContextField', item);
    if (result.ok) fields.push(item as ContextField);
    else issues.push(`context.json[${i}] is not a ContextField`);
  });
  return { fields, issues };
}

export function mergeContext(
  required: readonly string[],
  operator: Record<string, ContextValue>,
  harness: readonly ContextField[],
): MergedContext {
  const byHarness = new Map<string, ContextField>();
  for (const field of harness) if (!byHarness.has(field.key)) byHarness.set(field.key, field);
  const merged = new Map<string, ContextField>();
  const overrides: ContextOverride[] = [];

  const keys = new Set<string>([...required, ...Object.keys(operator), ...byHarness.keys()]);
  for (const key of keys) {
    const h = byHarness.get(key);
    const hasOperator = Object.prototype.hasOwnProperty.call(operator, key);
    const o = operator[key];
    if (h !== undefined && HARNESS_WINS.has(h.origin)) {
      merged.set(key, h);
      if (hasOperator && o !== h.value) {
        overrides.push({
          key,
          operator_value: o as ContextValue,
          harness_value: h.value,
          harness_origin: h.origin,
        });
      }
    } else if (hasOperator) {
      merged.set(key, { key, value: o as ContextValue, origin: 'operator_reported' });
    } else if (h !== undefined) {
      merged.set(key, h);
    } else if (required.includes(key)) {
      merged.set(key, { key, value: null, origin: 'unknown' });
    }
  }

  const ordered: ContextField[] = [];
  for (const key of required) {
    const field = merged.get(key);
    if (field !== undefined) ordered.push(field);
  }
  const rest = [...merged.keys()].filter((k) => !required.includes(k)).sort();
  for (const key of rest) ordered.push(merged.get(key) as ContextField);

  const unknown = required.filter((key) => {
    const field = merged.get(key);
    return field === undefined || field.value === null;
  });
  return { context: ordered, overrides, unknown };
}

/** `{ key: value }` over the non-null fields, the shape a pack's context.schema.json validates. */
export function projection(context: readonly ContextField[]): Record<string, ContextValue> {
  const out: Record<string, ContextValue> = {};
  for (const field of context) if (field.value !== null) out[field.key] = field.value;
  return out;
}

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
addFormatsModule.default(ajv);
const compiled = new Map<string, ValidateFunction>();

/** Validate any value against a pack schema (context or result); issues are `{ path, rule }` only. */
export function validateAgainst(
  schema: Record<string, unknown>,
  digest: string,
  value: unknown,
): ErrorDetail[] {
  let fn = compiled.get(digest);
  if (fn === undefined) {
    const copy: Record<string, unknown> = { ...schema };
    delete copy['$id'];
    fn = ajv.compile(copy);
    compiled.set(digest, fn);
  }
  if (fn(value)) return [];
  const seen = new Set<string>();
  const issues: ErrorDetail[] = [];
  for (const error of fn.errors ?? []) {
    let path = error.instancePath;
    if (error.keyword === 'required') {
      const missing = (error.params as { missingProperty?: unknown }).missingProperty;
      if (typeof missing === 'string')
        path = `${path}/${missing.replace(/~/g, '~0').replace(/\//g, '~1')}`;
    }
    const key = `${path} ${error.keyword}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({ path, rule: error.keyword });
  }
  return issues;
}
