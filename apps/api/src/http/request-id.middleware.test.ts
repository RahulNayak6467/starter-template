import express, { type Request } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { silentLogger } from '../../test/support/capture-logs.js';
import {
  createRequestIdMiddleware,
  REQUEST_ID_MAX_LENGTH,
  requireRequestContext,
} from './request-id.middleware.js';

const REQUEST_ID_HEADER = 'x-request-id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const createProbeApp = (rootLogger = silentLogger()) => {
  const app = express();
  app.use(createRequestIdMiddleware(rootLogger));
  app.get('/probe', (req, res) => {
    const { requestId, clientRequestId, logger } = requireRequestContext(req);
    const bindings = logger.bindings();

    res.json({
      requestId,
      clientRequestId: clientRequestId ?? null,
      boundRequestId: bindings.requestId as unknown,
      boundClientRequestId: (bindings.clientRequestId as unknown) ?? null,
    });
  });

  return { app, rootLogger };
};

describe('request ID middleware', () => {
  it('generates its own UUID and returns it in the header, the context and the logger', async () => {
    const { app } = createProbeApp();

    const response = await request(app).get('/probe');

    const requestId = response.headers[REQUEST_ID_HEADER];
    expect(requestId).toMatch(UUID);
    expect(response.body).toEqual({
      requestId,
      clientRequestId: null,
      boundRequestId: requestId,
      boundClientRequestId: null,
    });
  });

  it('never uses the client ID as the request ID, even a valid one', async () => {
    const { app } = createProbeApp();

    const response = await request(app)
      .get('/probe')
      .set(REQUEST_ID_HEADER, 'client-request_123.production');

    expect(response.headers[REQUEST_ID_HEADER]).toMatch(UUID);
    expect(response.body).toMatchObject({
      clientRequestId: 'client-request_123.production',
      boundClientRequestId: 'client-request_123.production',
    });
  });

  it('gives two requests that reuse the same client ID different request IDs', async () => {
    const { app } = createProbeApp();

    const [first, second] = await Promise.all([
      request(app).get('/probe').set(REQUEST_ID_HEADER, 'reused-id'),
      request(app).get('/probe').set(REQUEST_ID_HEADER, 'reused-id'),
    ]);

    expect(first.headers[REQUEST_ID_HEADER]).not.toBe(second.headers[REQUEST_ID_HEADER]);
    expect(first.body).toMatchObject({ clientRequestId: 'reused-id' });
    expect(second.body).toMatchObject({ clientRequestId: 'reused-id' });
  });

  it.each([
    ['', 'empty'],
    ['contains a space', 'space'],
    ['contains/slash', 'unsupported character'],
    ['first-id, second-id', 'two values'],
    ['{"injected":true}', 'JSON fragment'],
    ['a'.repeat(REQUEST_ID_MAX_LENGTH + 1), 'too long'],
  ])('drops the invalid client ID %j (%s)', async (incoming) => {
    const { app } = createProbeApp();

    const response = await request(app).get('/probe').set(REQUEST_ID_HEADER, incoming);

    expect(response.headers[REQUEST_ID_HEADER]).toMatch(UUID);
    expect(response.body).toMatchObject({ clientRequestId: null, boundClientRequestId: null });
  });

  it('accepts a client ID at the maximum length', async () => {
    const longest = 'a'.repeat(REQUEST_ID_MAX_LENGTH);
    const { app } = createProbeApp();

    const response = await request(app).get('/probe').set(REQUEST_ID_HEADER, longest);

    expect(response.body).toMatchObject({ clientRequestId: longest });
  });

  it('never adds request bindings to the root logger', async () => {
    const { app, rootLogger } = createProbeApp();

    await request(app).get('/probe').set(REQUEST_ID_HEADER, 'client-id');

    expect(rootLogger.bindings()).not.toHaveProperty('requestId');
    expect(rootLogger.bindings()).not.toHaveProperty('clientRequestId');
  });
});

describe('requireRequestContext', () => {
  it('throws a clear error when the request ID middleware has not run', () => {
    const app = express();
    let thrown: unknown;
    app.get('/probe', (req: Request, res) => {
      try {
        requireRequestContext(req);
      } catch (error) {
        thrown = error;
      }
      res.status(204).end();
    });

    return request(app)
      .get('/probe')
      .then(() => {
        expect(thrown).toBeInstanceOf(Error);
        expect(String(thrown)).toContain('the request ID middleware must run first');
      });
  });
});
