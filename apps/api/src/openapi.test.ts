import { systemClock } from '@starter/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { silentLogger } from '../test/support/capture-logs.js';
import { createApp } from './http/app.js';
import {
  liveResponseSchema,
  notReadyResponseSchema,
  readyResponseSchema,
} from './health/health.routes.js';
import type { ReadinessChecker } from './health/readiness.js';
import { errorResponseSchema } from './http/error.middleware.js';
import { REQUEST_ID_HEADER } from './http/request-id.middleware.js';
import { buildOpenApiDocument } from './openapi.js';

const ready: ReadinessChecker = () => Promise.resolve({ status: 'ready' });
const notReady: ReadinessChecker = () =>
  Promise.resolve({ status: 'not_ready', reason: 'draining' });
const broken: ReadinessChecker = () => Promise.reject(new Error('checker bug'));

const createTestApp = (checkReadiness: ReadinessChecker = ready) =>
  createApp({ logger: silentLogger(), clock: systemClock, checkReadiness });

const strictError = z.strictObject({
  error: z.strictObject(errorResponseSchema.shape.error.shape),
});

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'] as const;

const documentedOperations = Object.entries(buildOpenApiDocument().paths ?? {}).flatMap(
  ([path, pathItem]) =>
    HTTP_METHODS.filter((method) => pathItem[method] !== undefined).map(
      (method) => [method, path] as const,
    ),
);

describe('OpenAPI document', () => {
  it.each([
    ['/health/live', 200, 'LiveResponse', z.strictObject(liveResponseSchema.shape), ready],
    ['/health/ready', 200, 'ReadyResponse', z.strictObject(readyResponseSchema.shape), ready],
    [
      '/health/ready',
      503,
      'NotReadyResponse',
      z.strictObject(notReadyResponseSchema.shape),
      notReady,
    ],
    ['/health/ready', 500, 'ErrorResponse', strictError, broken],
  ] satisfies [string, number, string, z.ZodType, ReadinessChecker][])(
    'GET %s %i is documented as %s and the real body matches it exactly',
    async (path, status, component, schema, checkReadiness) => {
      const document = buildOpenApiDocument();

      const response = await request(createTestApp(checkReadiness)).get(path);

      expect(response.status).toBe(status);
      expect(document).toHaveProperty(
        [
          'paths',
          path,
          'get',
          'responses',
          String(status),
          'content',
          'application/json',
          'schema',
          '$ref',
        ],
        `#/components/schemas/${component}`,
      );
      expect(document).toHaveProperty(['components', 'schemas', component]);
      expect(schema.safeParse(response.body).success).toBe(true);
      expect(response.headers[REQUEST_ID_HEADER]).toEqual(expect.any(String));
    },
  );

  it('rejects bodies with keys the contract does not allow', () => {
    expect(
      z.strictObject(notReadyResponseSchema.shape).safeParse({
        status: 'not_ready',
        reason: 'draining',
      }).success,
    ).toBe(false);
    expect(
      strictError.safeParse({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal error',
          requestId: null,
          retryable: false,
          stack: 'Error: at …',
        },
      }).success,
    ).toBe(false);
  });

  it('documents at least one operation', () => {
    expect(documentedOperations.length).toBeGreaterThan(0);
  });

  it.each(documentedOperations)('serves the documented %s %s', async (method, path) => {
    const response = await request(createTestApp())[method](path);

    expect(response.status).not.toBe(404);
  });
});
