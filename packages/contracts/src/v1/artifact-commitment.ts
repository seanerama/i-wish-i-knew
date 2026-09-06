// ArtifactCommitment — digest + access policy for evidence retained locally
// (contracts/evidence-envelope.md, entity table). The raw artifact never
// leaves the member's vault; only this commitment travels with the Run.
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { Count, Digest, StringEnum } from './common.js';

export const ArtifactKind = StringEnum(
  ['attempts', 'stdout', 'stderr', 'harness_output', 'file'] as const,
  'What the retained artifact is',
);
export type ArtifactKind = Static<typeof ArtifactKind>;

export const ArtifactAccess = StringEnum(
  ['vault_only', 'on_request', 'cooperative'] as const,
  'Access policy: vault_only never leaves the node; on_request is disclosed only to a challenge; cooperative may be shared with the cohort',
);
export type ArtifactAccess = Static<typeof ArtifactAccess>;

export const ArtifactCommitment = Type.Object(
  {
    digest: Digest,
    kind: ArtifactKind,
    size_bytes: Count,
    media_type: Type.Optional(Type.String()),
    access: ArtifactAccess,
  },
  {
    additionalProperties: false,
    description: 'Digest and access policy for an artifact retained in the local vault',
  },
);
export type ArtifactCommitment = Static<typeof ArtifactCommitment>;
