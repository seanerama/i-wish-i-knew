// OpenAPI 3.1 document for the member-api v1 surface this service exposes.
// Authored alongside the routes; test/openapi.test.ts fails if a registered
// /v1 route is missing here or a documented path has no route.
import { schemaDocument } from '@iwik/contracts';

const ERROR_ENVELOPE = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: {
          type: 'array',
          items: {
            type: 'object',
            required: ['path', 'rule'],
            properties: { path: { type: 'string' }, rule: { type: 'string' } },
          },
        },
      },
    },
  },
};

const RECEIPT = {
  type: 'object',
  required: ['receipt_id', 'kind', 'status', 'evidence_revision', 'issued_at'],
  properties: {
    receipt_id: { type: 'string' },
    kind: { type: 'string', enum: ['intake'] },
    status: {
      type: 'string',
      enum: ['accepted', 'duplicate'],
      description:
        'duplicate (stage 8, behind IWIK_FEATURE_DEDUPE): the same measurement was already accepted from this organization; the run is stored but not counted',
    },
    run_id: { type: 'string' },
    content_digest: { type: 'string' },
    protocol_ref: { type: 'string' },
    execution_status: { type: 'string' },
    sharing_policy: { type: 'string', enum: ['private', 'cooperative'] },
    duplicate_of: {
      type: 'string',
      description: 'With status duplicate: the earlier run id, always one of your own',
    },
    evidence_revision: { type: 'integer' },
    issued_at: { type: 'string', format: 'date-time' },
  },
};

/** Operator cohort preview (stage 8): ranges only, never exact counts. */
const COHORT_RANGES = {
  type: 'object',
  required: ['protocol_ref', 'filters', 'orgs', 'runs', 'max_org_share', 'evidence_revision'],
  properties: {
    protocol_ref: { type: 'string' },
    filters: {
      type: 'object',
      additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
    },
    orgs: { type: 'string', enum: ['<3', '3-5', '6-10', '11+'] },
    runs: { type: 'string', enum: ['<5', '5-10', '11-50', '51+'] },
    max_org_share: { type: 'string', enum: ['<=50%', '>50%'] },
    evidence_revision: { type: 'integer', minimum: 0 },
  },
};

/** A query receipt as re-read through GET /v1/receipts/{id}: the AnswerReceipt plus `kind: query`. */
const QUERY_RECEIPT = {
  allOf: [
    { $ref: '#/components/schemas/AnswerReceipt' },
    {
      type: 'object',
      required: ['kind'],
      properties: { kind: { type: 'string', enum: ['query'] } },
    },
  ],
};

const QUERY_REQUEST = {
  type: 'object',
  required: ['protocol_ref'],
  additionalProperties: false,
  properties: {
    protocol_ref: { type: 'string' },
    investigation_id: { type: 'string' },
    context_filters: {
      type: 'object',
      additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
    },
    as_of_revision: { type: 'integer', minimum: 0 },
  },
};

const WITHDRAWAL_REQUEST = {
  type: 'object',
  required: ['run_ids', 'reason_code'],
  additionalProperties: false,
  properties: {
    run_ids: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
    },
    reason_code: { type: 'string', enum: ['member_request', 'data_error', 'policy_change'] },
  },
};

const WITHDRAWAL = {
  type: 'object',
  required: ['withdrawal_id', 'effective_revision'],
  properties: {
    withdrawal_id: { type: 'string' },
    effective_revision: { type: 'integer', minimum: 0 },
  },
};

const ULID = { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' };

/** Stage 10: file a challenge (the Challenge entity's target, grounds, statement). */
const CHALLENGE_REQUEST = {
  type: 'object',
  required: ['target', 'grounds'],
  additionalProperties: false,
  properties: {
    target: {
      type: 'object',
      required: ['kind', 'id'],
      additionalProperties: false,
      properties: { kind: { type: 'string', enum: ['receipt', 'claim'] }, id: ULID },
    },
    grounds: {
      type: 'string',
      enum: ['method', 'context_mismatch', 'data_error', 'replication_failed', 'affiliation'],
    },
    statement: { $ref: '#/components/schemas/Challenge/properties/statement' },
  },
};

const RESOLVE_REQUEST = {
  type: 'object',
  required: ['resolution', 'relationship'],
  additionalProperties: false,
  properties: {
    resolution: { type: 'string', enum: ['upheld', 'rejected', 'superseded'] },
    relationship: {
      type: 'object',
      required: ['kind', 'rationale'],
      additionalProperties: false,
      properties: {
        kind: {
          type: 'string',
          enum: ['contradicts', 'narrows', 'supersedes'],
          description:
            'Must match the resolution: upheld contradicts, rejected narrows, superseded supersedes',
        },
        rationale: { $ref: '#/components/schemas/Relationship/properties/rationale' },
      },
    },
  },
};

const RESOLVED = {
  type: 'object',
  required: ['challenge_id', 'status', 'resolution', 'relationships', 'resolved_revision'],
  properties: {
    challenge_id: ULID,
    status: { type: 'string', enum: ['resolved'] },
    resolution: { type: 'string', enum: ['upheld', 'rejected', 'superseded'] },
    relationship_id: ULID,
    relationships: { type: 'integer', minimum: 0 },
    resolved_revision: { type: 'integer', minimum: 0 },
  },
};

/** Stage 10: the two steps of POST /v1/outcomes. */
const OUTCOME_REQUEST = {
  oneOf: [
    {
      type: 'object',
      required: ['prediction'],
      additionalProperties: false,
      properties: {
        prediction: {
          type: 'object',
          required: ['based_on_receipt_id', 'target', 'horizon', 'evaluation_rule'],
          additionalProperties: false,
          properties: {
            based_on_receipt_id: ULID,
            target: { $ref: '#/components/schemas/Prediction/properties/target' },
            horizon: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' },
            probability: { type: 'number', minimum: 0, maximum: 1 },
            evaluation_rule: { $ref: '#/components/schemas/Prediction/properties/evaluation_rule' },
          },
        },
      },
    },
    {
      type: 'object',
      required: ['prediction_id', 'observed'],
      additionalProperties: false,
      properties: {
        prediction_id: ULID,
        observed: { $ref: '#/components/schemas/Outcome/properties/observed' },
        target: {
          allOf: [{ $ref: '#/components/schemas/Prediction/properties/target' }],
          description:
            'Optional restatement; 409 target_mismatch when it differs from the registered target',
        },
        based_on_receipt_id: {
          allOf: [ULID],
          description:
            'Optional restatement; 409 target_mismatch when it differs from the registered receipt',
        },
      },
    },
  ],
};

const WHOAMI = {
  type: 'object',
  required: ['node_id', 'org_display_name', 'scopes'],
  properties: {
    node_id: { type: 'string' },
    org_display_name: { type: 'string' },
    scopes: { type: 'array', items: { type: 'string', enum: ['query', 'submit', 'publish'] } },
  },
};

function errorResponses(...codes: Array<[number, string]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [status, description] of codes) {
    out[String(status)] = {
      description,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
    };
  }
  return out;
}

const bearer = [{ nodeToken: [] }];

function stripDialect(schema: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...schema };
  delete copy['$schema'];
  delete copy['$id'];
  return copy;
}

export function buildOpenApi(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'I Wish I Knew member-api',
      version: '1.0.0',
      description:
        'Authenticated surface between member nodes and the cooperative service (contracts/member-api.md). ' +
        'Error bodies carry JSON paths and rule names only, never submitted values.',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        nodeToken: { type: 'http', scheme: 'bearer' },
        operatorToken: {
          type: 'http',
          scheme: 'bearer',
          description:
            'IWIK_OPERATOR_TOKEN; authorizes the /v1/admin endpoints only and never grants evidence access',
        },
      },
      schemas: {
        ErrorEnvelope: ERROR_ENVELOPE,
        Run: stripDialect(schemaDocument('Run')),
        ProtocolVersion: stripDialect(schemaDocument('ProtocolVersion')),
        AnswerReceipt: stripDialect(schemaDocument('AnswerReceipt')),
        IntakeReceipt: RECEIPT,
        QueryReceipt: QUERY_RECEIPT,
        QueryRequest: QUERY_REQUEST,
        WhoAmI: WHOAMI,
        WithdrawalRequest: WITHDRAWAL_REQUEST,
        Withdrawal: WITHDRAWAL,
        CohortRanges: COHORT_RANGES,
        Challenge: stripDialect(schemaDocument('Challenge')),
        Claim: stripDialect(schemaDocument('Claim')),
        Relationship: stripDialect(schemaDocument('Relationship')),
        Prediction: stripDialect(schemaDocument('Prediction')),
        Outcome: stripDialect(schemaDocument('Outcome')),
        ChallengeRequest: CHALLENGE_REQUEST,
        ResolveRequest: RESOLVE_REQUEST,
        Resolved: RESOLVED,
        OutcomeRequest: OUTCOME_REQUEST,
      },
    },
    paths: {
      '/healthz': {
        get: { summary: 'Liveness', responses: { '200': { description: 'alive' } } },
      },
      '/readyz': {
        get: {
          summary: 'Readiness: database reachable and migrations current',
          responses: {
            '200': { description: '{ ok: true }' },
            '503': { description: 'not ready' },
          },
        },
      },
      '/v1/openapi.json': {
        get: { summary: 'This document', responses: { '200': { description: 'OpenAPI 3.1' } } },
      },
      '/v1/protocols': {
        get: {
          summary: 'List accepted protocol versions',
          security: bearer,
          'x-scope': 'query',
          responses: {
            '200': { description: '{ protocols: ProtocolVersion[] }' },
            ...errorResponses([401, 'unauthorized'], [403, 'scope_required']),
          },
        },
      },
      '/v1/protocols/{pack}/{protocol}': {
        get: {
          summary: 'One ProtocolVersion with pack digests and download pointer',
          security: bearer,
          'x-scope': 'query',
          parameters: [
            { name: 'pack', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'protocol', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'ProtocolVersion + pack' },
            ...errorResponses([401, 'unauthorized'], [403, 'scope_required'], [404, 'not_found']),
          },
        },
      },
      '/v1/protocols/{ref}': {
        get: {
          summary: 'One ProtocolVersion by percent-encoded ref',
          security: bearer,
          'x-scope': 'query',
          parameters: [{ name: 'ref', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'ProtocolVersion + pack' },
            ...errorResponses([401, 'unauthorized'], [403, 'scope_required'], [404, 'not_found']),
          },
        },
      },
      '/v1/contributions/preview': {
        post: {
          summary: 'Dry-run intake: validation, sanitization report, what would be stored',
          security: bearer,
          'x-scope': 'submit',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['run'],
                  properties: { run: { $ref: '#/components/schemas/Run' } },
                },
              },
            },
          },
          responses: {
            '200': {
              description:
                '{ preview_id, content_digest, expires_at, validation, sanitization, would_store }',
            },
            ...errorResponses(
              [401, 'unauthorized'],
              [403, 'scope_required'],
              [422, 'validation_failed'],
              [503, 'feature_disabled'],
            ),
          },
        },
      },
      '/v1/runs': {
        post: {
          summary: 'Submit a signed Run bound to a preview; idempotent on run_id',
          security: bearer,
          'x-scope': 'submit',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['preview_id', 'run'],
                  properties: {
                    preview_id: { type: 'string' },
                    run: { $ref: '#/components/schemas/Run' },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description:
                'accepted (status accepted; or status duplicate with duplicate_of when IWIK_FEATURE_DEDUPE is on and the same measurement was already accepted from your organization)',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/IntakeReceipt' } },
              },
            },
            '200': {
              description: 'already accepted with the same content: the original receipt',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/IntakeReceipt' } },
              },
            },
            ...errorResponses(
              [401, 'unauthorized or bad_signature'],
              [403, 'scope_required'],
              [404, 'preview_not_found'],
              [409, 'preview_mismatch, preview_expired, or run_conflict'],
              [422, 'validation_failed'],
              [503, 'feature_disabled'],
            ),
          },
        },
      },
      '/v1/runs/{run_id}': {
        get: {
          summary: 'Read back one of your organization’s runs (decrypted)',
          security: bearer,
          'x-scope': 'query',
          parameters: [{ name: 'run_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description:
                '{ run, receipt_id, evidence_revision, received_at, withdrawn_at?, withdrawn_revision? } (the last two, stage 7 additive, only once withdrawn)',
            },
            ...errorResponses([401, 'unauthorized'], [403, 'scope_required'], [404, 'not_found']),
          },
        },
      },
      '/v1/withdrawals': {
        post: {
          summary:
            'Withdraw own runs (stage 7); effective at the next evidence revision, idempotent on the set of run ids',
          description:
            'Requires IWIK_FEATURE_WITHDRAWAL=on (404 feature_disabled otherwise, before authentication). ' +
            'Every run id must belong to the caller’s organization: any foreign or unknown id makes the whole ' +
            'request 404 not_found and nothing is withdrawn; the response never says which id. The same set ' +
            '(any order) returns the original withdrawal with 200. Query receipts issued for an affected protocol ' +
            'before the effective revision read status stale on GET /v1/receipts/{id}.',
          security: bearer,
          'x-scope': 'publish',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/WithdrawalRequest' },
              },
            },
          },
          responses: {
            '201': {
              description: 'withdrawal recorded',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Withdrawal' } },
              },
            },
            '200': {
              description: 'the same set was already withdrawn: the original withdrawal',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Withdrawal' } },
              },
            },
            ...errorResponses(
              [401, 'unauthorized or node_revoked'],
              [403, 'scope_required'],
              [404, 'not_found (a run id is not yours) or feature_disabled'],
              [422, 'validation_failed'],
            ),
          },
        },
      },
      '/v1/admin/organizations': {
        post: {
          summary:
            'Operator bootstrap (stage 6, additive): create an organization and its one-time enrollment invite',
          description:
            'Requires IWIK_FEATURE_ENROLLMENT=on (404 otherwise) and the operator token. ' +
            'The invite URL is returned exactly once; only its hash is stored.',
          security: [{ operatorToken: [] }],
          'x-scope': 'operator',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: { name: { type: 'string', minLength: 1, maxLength: 120 } },
                },
              },
            },
          },
          responses: {
            '201': { description: '{ org_id, invite_url, expires_at }' },
            ...errorResponses(
              [401, 'unauthorized'],
              [404, 'not_found (feature disabled)'],
              [409, 'name_taken'],
              [422, 'validation_failed'],
            ),
          },
        },
      },
      '/v1/admin/organizations/{org_id}/invites': {
        post: {
          summary:
            'Operator re-invite (stage 11, additive): a one-time reset invite for an existing organization',
          description:
            'Requires IWIK_FEATURE_ENROLLMENT=on (404 otherwise) and the operator token. ' +
            'An enrolled organization gets a `reset` invite: accepting it at /enroll/<invite> sets a new ' +
            'console password, keeps the display name, nodes, and tokens, and records a new agreement only ' +
            'if the pilot terms version changed. An organization that never completed enrollment gets a ' +
            'fresh `enroll` invite instead. Never creates a second organization. ' +
            'The invite URL is returned exactly once; only its hash is stored.',
          security: [{ operatorToken: [] }],
          'x-scope': 'operator',
          parameters: [{ name: 'org_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '201': { description: '{ org_id, kind: "reset" | "enroll", invite_url, expires_at }' },
            ...errorResponses(
              [401, 'unauthorized'],
              [404, 'not_found (unknown organization, or feature disabled)'],
              [409, 'invite_exists (an unexpired, unaccepted invite already exists)'],
            ),
          },
        },
      },
      '/v1/admin/cohorts': {
        get: {
          summary:
            'Operator cohort preview (stage 8, additive): how many organizations and runs a (protocol, filters) cohort has, as ranges only',
          description:
            'Requires IWIK_FEATURE_DEDUPE=on (404 feature_disabled otherwise, before authentication) and the operator ' +
            'token. Filters are query parameters named `filter.<key>` where <key> is one of the protocol’s ' +
            'required_context keys (any other key is 422 not_indexed); values parse as JSON scalars (`1`, `true`, ' +
            '`null`), otherwise as strings, and match the run’s indexed value exactly. Counts exclude withdrawn runs, ' +
            'fixture runs, and same-organization duplicates; organizations that submitted the same measurement ' +
            '(shared_source_suspect) count as one. Exact counts are never returned: orgs and runs use the ' +
            'AnswerReceipt count-range vocabulary and the largest organization’s share is reported only as ' +
            'which side of the ADR-0002 50 % cap it falls on.',
          security: [{ operatorToken: [] }],
          'x-scope': 'operator',
          parameters: [
            { name: 'protocol_ref', in: 'query', required: true, schema: { type: 'string' } },
            {
              name: 'filter.<key>',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description:
                'One per required_context key to filter on; repeatable with different keys',
            },
          ],
          responses: {
            '200': {
              description: 'ranges',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/CohortRanges' } },
              },
            },
            ...errorResponses(
              [401, 'unauthorized'],
              [404, 'feature_disabled'],
              [
                422,
                'validation_failed (protocol_ref shape, protocol_unknown, or a filter key that is not indexed)',
              ],
            ),
          },
        },
      },
      '/v1/challenges': {
        post: {
          summary:
            'File a structured challenge (stage 10) against a released query receipt of your organization, or one claim released on it',
          description:
            'Requires IWIK_FEATURE_CHALLENGE=on (404 feature_disabled otherwise, before authentication). ' +
            'grounds is one of method, context_mismatch, data_error, replication_failed, affiliation; statement ' +
            'carries fixed-vocabulary fields (claim, metric, statistic, context_key, direction, and ' +
            'replication_run_id, which must be one of your own runs) plus one bounded note (at most 500 ' +
            'characters, rescanned for secret patterns, shown to the operator only). A receipt that is not yours, ' +
            'a claim not released on one of your receipts, or a foreign replication run is 404 not_found; a ' +
            'receipt without a released answer is 422 not_released. At most 5 challenges per organization per ' +
            'rolling 24 hours: the sixth is 429 with Retry-After and the earlier five are unaffected. Released ' +
            'findings carry their claim_id (additive on AnswerReceipt.result.findings). A challenge is visible to ' +
            'the filing organization and the operator only and never names another organization’s runs.',
          security: bearer,
          'x-scope': 'publish',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ChallengeRequest' } },
            },
          },
          responses: {
            '201': {
              description: 'the challenge, status open',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Challenge' } },
              },
            },
            ...errorResponses(
              [401, 'unauthorized or node_revoked'],
              [403, 'scope_required'],
              [404, 'not_found (target not yours) or feature_disabled'],
              [422, 'validation_failed (shape, enum, note too long, secret_pattern, not_released)'],
              [429, 'rate_limited (Retry-After in seconds)'],
            ),
          },
        },
      },
      '/v1/challenges/{id}': {
        get: {
          summary: 'Re-read one of your organization’s challenges (stage 10); anyone else’s is 404',
          security: bearer,
          'x-scope': 'query',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description:
                'the challenge with its status, resolution, and relationship when resolved',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Challenge' } },
              },
            },
            ...errorResponses(
              [401, 'unauthorized'],
              [403, 'scope_required'],
              [404, 'not_found or feature_disabled'],
            ),
          },
        },
      },
      '/v1/admin/challenges/{id}/resolve': {
        post: {
          summary:
            'Operator resolution (stage 10, additive): upheld, rejected, or superseded; records a Relationship per claim the challenge bears on and bumps the evidence revision',
          description:
            'Requires IWIK_FEATURE_CHALLENGE=on (404 feature_disabled otherwise) and the operator token. ' +
            'relationship.kind must match the resolution (upheld contradicts, rejected narrows, superseded ' +
            'supersedes; anything else is 422 resolution_kind) and rationale is fixed vocabulary. The challenge’s ' +
            'assertion is recorded as a counter-claim (origin reported); an upheld or superseded resolution marks ' +
            'the targeted claims contradicted or rejected with corroboration disputed. Every resolution moves the ' +
            'evidence revision (revision_log kind challenge), so query receipts of that protocol issued earlier ' +
            'read stale. 409 challenge_resolved when already resolved. Audit rows carry ids only.',
          security: [{ operatorToken: [] }],
          'x-scope': 'operator',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ResolveRequest' } },
            },
          },
          responses: {
            '200': {
              description: 'resolved',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Resolved' } },
              },
            },
            ...errorResponses(
              [401, 'unauthorized'],
              [404, 'not_found or feature_disabled'],
              [409, 'challenge_resolved'],
              [422, 'validation_failed'],
            ),
          },
        },
      },
      '/v1/outcomes': {
        post: {
          summary:
            'Register a prediction before its outcome is known, then report the observation against it (stage 10, two steps)',
          description:
            'Requires IWIK_FEATURE_CHALLENGE=on (404 feature_disabled otherwise, before authentication). ' +
            'Step 1, { prediction }: based_on_receipt_id must be one of your query receipts; target.claim must be ' +
            'one of the protocol’s permitted claims; horizon is a date not in the past. Returns 201 with the ' +
            'Prediction (prediction_id, registered_at). Step 2, { prediction_id, observed }: records the ' +
            'observation exactly once (409 outcome_exists on a second) and returns 201 with the Outcome, whose ' +
            'prediction is exactly what was registered. The stored prediction can never be altered: a body that ' +
            'carries prediction together with prediction_id is 409 prediction_immutable, and a restated target or ' +
            'based_on_receipt_id that differs from the registered one is 409 target_mismatch. ' +
            'observed.environment_changed is stored separately from observed.result.',
          security: bearer,
          'x-scope': 'publish',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/OutcomeRequest' } },
            },
          },
          responses: {
            '201': {
              description: 'Prediction (step 1) or Outcome (step 2)',
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      { $ref: '#/components/schemas/Prediction' },
                      { $ref: '#/components/schemas/Outcome' },
                    ],
                  },
                },
              },
            },
            ...errorResponses(
              [401, 'unauthorized or node_revoked'],
              [403, 'scope_required'],
              [404, 'not_found (receipt, prediction, or run not yours) or feature_disabled'],
              [409, 'prediction_immutable, target_mismatch, or outcome_exists'],
              [422, 'validation_failed (shape, enum, claim_unknown, horizon in the past)'],
            ),
          },
        },
      },
      '/v1/receipts/{id}': {
        get: {
          summary:
            'Re-read one of your organization’s receipts (intake or query); a query receipt reads status stale once a later evidence revision touched its protocol (stage 7)',
          security: bearer,
          'x-scope': 'query',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'receipt',
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      { $ref: '#/components/schemas/IntakeReceipt' },
                      { $ref: '#/components/schemas/QueryReceipt' },
                    ],
                  },
                },
              },
            },
            ...errorResponses([401, 'unauthorized'], [403, 'scope_required'], [404, 'not_found']),
          },
        },
      },
      '/v1/whoami': {
        get: {
          summary:
            'Node identity (stage 5, additive): the node id, organization display name, and scopes behind the presented token; never the org_ref',
          security: bearer,
          'x-scope': 'any',
          responses: {
            '200': {
              description: 'identity',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/WhoAmI' } } },
            },
            ...errorResponses([401, 'unauthorized or node_revoked']),
          },
        },
      },
      '/v1/evidence/query': {
        post: {
          summary:
            'Compatible-cohort evidence query: a released, suppressed, or insufficient AnswerReceipt (stage 9 behind IWIK_FEATURE_COOPERATIVE_QUERY; the stage 5 stub answer otherwise)',
          description:
            'With IWIK_FEATURE_COOPERATIVE_QUERY=on: candidates are accepted, cooperative, non-withdrawn, non-fixture, ' +
            'non-duplicate runs of the protocol executed with a compatible harness digest whose indexed required ' +
            'context matches every context_filters key exactly (a filter key outside required_context is 422 ' +
            'not_indexed); as_of_revision pins the cohort at an earlier evidence revision (422 maximum when above ' +
            'the current one): runs accepted at or before it, but never a withdrawn run, whatever the pin ' +
            '(ADR-0002 §6), so a pinned answer whose cohort no longer matches the release recorded at that ' +
            'revision carries the limitation "Pinned cohort no longer reproducible: contributions changed since ' +
            'the pinned revision." or is suppressed as usual. Policy 2026-09-p1 releases only with at least 3 organizations, 5 runs, no ' +
            'organization above 50 % of the runs, and no prior release of the protocol whose member set differs by ' +
            'fewer than 3 organizations (differencing). Counts are bands; result sections are typed additively in ' +
            'the AnswerReceipt schema; result.own_evidence lists the caller’s own runs (their ids) even when the ' +
            'cooperative cohort is suppressed. Off (the default): status insufficient_evidence with reason ' +
            'no_cooperative_evidence. Either way the receipt is persisted (kind query) and re-readable through ' +
            'GET /v1/receipts/{id}, where it reads stale once a later revision touched its protocol.',
          security: bearer,
          'x-scope': 'query',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/QueryRequest' } },
            },
          },
          responses: {
            '200': {
              description: 'AnswerReceipt (released, suppressed, or insufficient_evidence)',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/AnswerReceipt' } },
              },
            },
            ...errorResponses(
              [401, 'unauthorized'],
              [403, 'scope_required'],
              [422, 'validation_failed (shape, or protocol_unknown)'],
            ),
          },
        },
      },
    },
  };
}
