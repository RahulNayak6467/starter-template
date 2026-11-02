import { createDocument, type oas31 } from 'zod-openapi';

import {
  liveResponseSchema,
  notReadyResponseSchema,
  readyResponseSchema,
} from './health/health.routes.js';
import { errorResponseSchema } from './http/error.middleware.js';
import { REQUEST_ID_HEADER } from './http/request-id.middleware.js';

export const API_CONTRACT_VERSION = '0.1.0';

const commonHeaders = {
  [REQUEST_ID_HEADER]: {
    description: 'ID of this request; quote it when reporting a problem.',
    schema: { type: 'string' },
  },
} satisfies oas31.HeadersObject;

const probeHeaders = {
  ...commonHeaders,
  'Cache-Control': {
    description: 'Probe answers are never cached.',
    schema: { type: 'string', enum: ['no-store'] },
  },
} satisfies oas31.HeadersObject;

const internalErrorResponse = {
  description: 'Unexpected error. The body never contains internal details.',
  headers: commonHeaders,
  content: { 'application/json': { schema: errorResponseSchema } },
};

export const buildOpenApiDocument = (): ReturnType<typeof createDocument> =>
  createDocument({
    openapi: '3.1.0',
    info: {
      title: 'Starter API',
      version: API_CONTRACT_VERSION,
      description: 'Example API for a TypeScript monorepo with PostgreSQL and Redis.',
    },
    tags: [{ name: 'health', description: 'Liveness and readiness probes' }],
    paths: {
      '/health/live': {
        get: {
          operationId: 'getLiveness',
          tags: ['health'],
          summary: 'Liveness probe',
          description: 'Checks no dependencies: a database outage must not restart the API.',
          responses: {
            '200': {
              description: 'The process is alive.',
              headers: probeHeaders,
              content: { 'application/json': { schema: liveResponseSchema } },
            },
            '500': internalErrorResponse,
          },
        },
      },
      '/health/ready': {
        get: {
          operationId: 'getReadiness',
          tags: ['health'],
          summary: 'Readiness probe',
          description: 'One public 503 body for every reason; the reason is only logged.',
          responses: {
            '200': {
              description: 'Ready to serve traffic.',
              headers: probeHeaders,
              content: { 'application/json': { schema: readyResponseSchema } },
            },
            '503': {
              description: 'Not ready: draining, or PostgreSQL or Redis is unavailable.',
              headers: probeHeaders,
              content: { 'application/json': { schema: notReadyResponseSchema } },
            },
            '500': internalErrorResponse,
          },
        },
      },
    },
  });
