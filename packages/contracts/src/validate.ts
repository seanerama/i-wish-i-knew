// Validation against the v1 envelope schemas with Ajv (draft 2020-12).
//
// `validate(entity, value)` returns `{ ok, errors: [{ path, rule }] }` and
// never echoes submitted values: `path` is a JSON pointer into the instance
// and `rule` is the schema keyword (or named semantic rule) that failed.
// This is the same shape the member-api error envelope carries.
// `validateTool(tool, side, value)` does the same for agent-tool inputs and
// outputs (contracts/schema/v1/tools/).
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { schemaDocument, schemaId, toolSchemaDocument, toolSchemaId } from './schema.js';
import type { ToolSide } from './schema.js';
import type { EntityName, Run } from './v1/index.js';
import { entityNames } from './v1/index.js';
import type { ToolName } from './v1/tools/index.js';
import { toolNames } from './v1/tools/index.js';

export interface ValidationIssue {
  /** JSON pointer to the offending location in the instance. */
  path: string;
  /** Schema keyword or named semantic rule, never a value. */
  rule: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
}

const ajv = new Ajv2020({
  // Strict everywhere except `strictRequired`, which rejects the legitimate
  // `if/then: { required: [...] }` conditional on Run.exclusion_reason.
  strictSchema: true,
  strictTypes: true,
  strictTuples: true,
  strictRequired: false,
  allErrors: true,
  validateFormats: true,
});
// ajv-formats is a CommonJS module; under NodeNext its default import is the
// module namespace and the plugin function sits on `.default`.
addFormatsModule.default(ajv);
for (const entity of entityNames) {
  ajv.addSchema(schemaDocument(entity));
}
for (const tool of toolNames) {
  ajv.addSchema(toolSchemaDocument(tool, 'input'));
  ajv.addSchema(toolSchemaDocument(tool, 'output'));
}

const compiled = new Map<string, ValidateFunction>();

function validatorById(id: string): ValidateFunction {
  const cached = compiled.get(id);
  if (cached !== undefined) return cached;
  const found = ajv.getSchema(id);
  if (found === undefined) throw new Error(`no schema registered for ${id}`);
  const fn = found as ValidateFunction;
  compiled.set(id, fn);
  return fn;
}

function toIssue(error: ErrorObject): ValidationIssue {
  let path = error.instancePath;
  // A missing property is a schema-known name, not a submitted value, so the
  // path can point at it directly (`/context` rather than `` for a missing
  // top-level `context`).
  if (error.keyword === 'required') {
    const missing = (error.params as { missingProperty?: unknown }).missingProperty;
    if (typeof missing === 'string') path = `${path}/${escapePointer(missing)}`;
  }
  return { path, rule: error.keyword };
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function collectIssues(fn: ValidateFunction): ValidationIssue[] {
  const seen = new Set<string>();
  const errors: ValidationIssue[] = [];
  for (const error of fn.errors ?? []) {
    const issue = toIssue(error);
    const key = `${issue.path} ${issue.rule}`;
    if (seen.has(key)) continue;
    seen.add(key);
    errors.push(issue);
  }
  return errors;
}

/**
 * Semantic rules JSON Schema cannot express. They run only when the schema
 * passed, so they can rely on the value's shape.
 */
const semanticRules: Partial<Record<EntityName, (value: never) => ValidationIssue[]>> = {
  Run: (run: Run): ValidationIssue[] => {
    const a = run.accounting;
    const reconciles =
      a.attempted === a.succeeded + a.failed &&
      a.planned === a.attempted + a.excluded + a.unobserved;
    return reconciles ? [] : [{ path: '/accounting', rule: 'accounting_reconciles' }];
  },
};

/** Validate `value` as the named v1 entity. */
export function validate(entity: EntityName, value: unknown): ValidationResult {
  const fn = validatorById(schemaId(entity));
  const ok = fn(value);
  if (!ok) return { ok: false, errors: collectIssues(fn) };
  const rule = semanticRules[entity];
  const errors = rule === undefined ? [] : rule(value as never);
  return { ok: errors.length === 0, errors };
}

/** Type guard form of `validate` for callers that want the static type. */
export function isValid<E extends EntityName>(entity: E, value: unknown): boolean {
  return validate(entity, value).ok;
}

/** Validate a tool input or output against the generated agent-tools schema. */
export function validateTool(tool: ToolName, side: ToolSide, value: unknown): ValidationResult {
  const fn = validatorById(toolSchemaId(tool, side));
  const ok = fn(value);
  return ok ? { ok: true, errors: [] } : { ok: false, errors: collectIssues(fn) };
}
