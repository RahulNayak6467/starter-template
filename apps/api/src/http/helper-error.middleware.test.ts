import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { silentLogger } from '../../test/support/capture-logs.js';
import { createErrorMiddleware } from './error.middleware.js';
import { createBodyLimitMiddleware, notFoundMiddleware } from './helper-error.middleware.js';
import { createRequestIdMiddleware } from './request-id.middleware.js';

const LIMIT_BYTES = 100;

const createApp = () => {
  const logger = silentLogger();
  const handler = vi.fn((_req: express.Request, res: express.Response) => {
    res.status(204).end();
  });
  const app = express();
  app.use(createRequestIdMiddleware(logger));
  app.use(createBodyLimitMiddleware(LIMIT_BYTES));
  app.use(express.json({ limit: '1mb' }));
  app.post('/known', handler);
  app.use(notFoundMiddleware);
  app.use(createErrorMiddleware(logger));

  return { app, handler };
};

describe('not found middleware', () => {
  it('turns an unknown route into a 404 ROUTE_NOT_FOUND envelope', async () => {
    const { app } = createApp();

    const response = await request(app).get('/unknown');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: 'Route not found',
        requestId: response.headers['x-request-id'],
        retryable: false,
      },
    });
  });
});

describe('body limit middleware', () => {
  it('rejects a declared body over the limit with 413 before any handler reads it', async () => {
    const { app, handler } = createApp();

    const response = await request(app)
      .post('/known')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ data: 'x'.repeat(LIMIT_BYTES) }));

    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('asks the client to close the connection after rejecting a large body', async () => {
    const { app } = createApp();

    const response = await request(app)
      .post('/known')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ data: 'x'.repeat(LIMIT_BYTES) }));

    expect(response.headers.connection).toBe('close');
  });

  it('lets a body exactly at the limit through', async () => {
    const { app, handler } = createApp();
    const body = JSON.stringify({ data: 'x'.repeat(LIMIT_BYTES - 11) });

    expect(Buffer.byteLength(body)).toBe(LIMIT_BYTES);
    const response = await request(app)
      .post('/known')
      .set('content-type', 'application/json')
      .send(body);

    expect(response.status).toBe(204);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('lets a request without a body through', async () => {
    const { app, handler } = createApp();

    const response = await request(app).post('/known');

    expect(response.status).toBe(204);
    expect(handler).toHaveBeenCalledOnce();
  });
});
