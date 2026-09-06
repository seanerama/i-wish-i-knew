// The JSON Schema documents exactly as committed under contracts/schema/v1/.
// `bin/build.ts` writes them; `validate.ts` compiles them. One function, so
// the files on disk and the validator can never diverge.
import type { EntityName } from './v1/index.js';
import { entities } from './v1/index.js';

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
