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
    status: { type: 'string', enum: ['accepted'] },
    run_id: { type: 'string' },
    content_digest: { type: 'string' },
    protocol_ref: { type: 'string' },
    execution_status: { type: 'string' },
    sharing_policy: { type: 'string', enum: ['private', 'cooperative'] },
    evidence_revision: { type: 'integer' },
    issued_at: { type: 'string', format: 'date-time' },
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
              description: 'accepted',
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
            '200': { description: '{ run, receipt_id, evidence_revision, received_at }' },
            ...errorResponses([401, 'unauthorized'], [403, 'scope_required'], [404, 'not_found']),
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
      '/v1/receipts/{id}': {
        get: {
          summary: 'Re-read one of your organization’s receipts (intake or query)',
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
            'Compatible-cohort evidence query (stage 5 stub): validates the request and answers an AnswerReceipt with status insufficient_evidence and reason no_cooperative_evidence until aggregation lands',
          description:
            'No matching or aggregation exists yet; the receipt is persisted (kind query) and re-readable through GET /v1/receipts/{id}.',
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
