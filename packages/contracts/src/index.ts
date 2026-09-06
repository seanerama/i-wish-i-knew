// @iwik/contracts — the frozen v1 evidence envelope as code (ADR-0005).
export * from './v1/index.js';
export * from './v1/tools/index.js';
export { canonicalize, digest } from './canonical.js';
export { validate, isValid, validateTool } from './validate.js';
export type { ValidationIssue, ValidationResult } from './validate.js';
export {
  schemaDocument,
  schemaId,
  toolSchemaDocument,
  toolSchemaId,
  toolSchemaFile,
  SCHEMA_DIALECT,
} from './schema.js';
export type { ToolSide } from './schema.js';
export {
  listFiles,
  treeDigest,
  fileDigest,
  protocolDigest,
  computePackDigests,
  staleFields,
} from './digest.js';
export type { PackManifest, PackDigests, PackProtocolDigests } from './digest.js';
