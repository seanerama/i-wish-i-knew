// @iwik/contracts — the frozen v1 evidence envelope as code (ADR-0005).
export * from './v1/index.js';
export { canonicalize, digest } from './canonical.js';
export { validate, isValid } from './validate.js';
export type { ValidationIssue, ValidationResult } from './validate.js';
export { schemaDocument, schemaId, SCHEMA_DIALECT } from './schema.js';
