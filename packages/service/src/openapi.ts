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
          description: 'IWIK_OPERATOR_TOKEN; authorizes POST /v1/admin/organizations only',
        },
      },
      schemas: {
        ErrorEnvelope: ERROR_ENVELOPE,
        Run: stripDialect(schemaDocument('Run')),
        ProtocolVersion: stripDialect(schemaDocument('ProtocolVersion')),
        IntakeReceipt: RECEIPT,
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
      '/v1/receipts/{id}': {
        get: {
          summary: 'Re-read one of your organization’s receipts',
          security: bearer,
          'x-scope': 'query',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'receipt',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/IntakeReceipt' } },
              },
            },
            ...errorResponses([401, 'unauthorized'], [403, 'scope_required'], [404, 'not_found']),
          },
        },
      },
    },
  };
}
