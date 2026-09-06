// The JSON Schema documents exactly as committed under contracts/schema/v1/.
// `bin/build.ts` writes them; `validate.ts` compiles them. One function, so
// the files on disk and the validator can never diverge. The agent-tool
// schemas (contracts/schema/v1/tools/) come from the same place.
import type { EntityName } from './v1/index.js';
import { entities } from './v1/index.js';
import type { ToolName } from './v1/tools/index.js';
import { tools } from './v1/tools/index.js';

export const SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/** `$id` of an entity schema. A URN: the artifacts are addressed by name, not by host. */
export function schemaId(entity: EntityName): string {
  return `urn:iwik:contracts:v1:${entity}`;
}

/** The plain-JSON schema document for one entity (TypeBox symbols stripped). */
export function schemaDocument(entity: EntityName): Record<string, unknown> {
  const body = JSON.parse(JSON.stringify(entities[entity])) as Record<string, unknown>;
  return {
    $schema: SCHEMA_DIALECT,
    $id: schemaId(entity),
    title: entity,
    ...body,
  };
}

export type ToolSide = 'input' | 'output';

/** `$id` of a tool input or output schema. */
export function toolSchemaId(tool: ToolName, side: ToolSide): string {
  return `urn:iwik:contracts:v1:tools:${tool}:${side}`;
}

/** File name of a tool schema under contracts/schema/v1/tools/. */
export function toolSchemaFile(tool: ToolName, side: ToolSide): string {
  return `${tool}.${side}.schema.json`;
}

/** The plain-JSON schema document for one tool's input or output. */
export function toolSchemaDocument(tool: ToolName, side: ToolSide): Record<string, unknown> {
  const definition = tools[tool];
  const body = JSON.parse(JSON.stringify(definition[side])) as Record<string, unknown>;
  const description =
    side === 'input'
      ? `${definition.description} Scope: ${definition.scope}; side effect: ${definition.side_effect}.`
      : `Output envelope of ${tool}: ${String(body['description'] ?? '')}`.trim();
  return {
    $schema: SCHEMA_DIALECT,
    $id: toolSchemaId(tool, side),
    title: `${tool} ${side}`,
    ...body,
    description,
  };
}
