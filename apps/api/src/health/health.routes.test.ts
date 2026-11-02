import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createHealthRoutes } from './health.routes.js';
import type { ReadinessChecker, ReadinessResult } from './readiness.js';

const createHealthApp = (result: ReadinessResult = { status: 'ready' }) => {
  const checkReadiness = vi.fn<ReadinessChecker>().mockResolvedValue(result);
  const app = express();
  app.use('/health', createHealthRoutes(checkReadiness));
  return { app, checkReadiness };
};

describe('health routes', () => {
  it('answers liveness with 200 and no-store, without checking readiness', async () => {
    const { app, checkReadiness } = createHealthApp({ status: 'not_ready', reason: 'timeout' });

    const response = await request(app).get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(response.headers['content-type']).toMatch(/^application\/json\b/u);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(checkReadiness).not.toHaveBeenCalled();
  });

  it('answers HEAD on liveness without a body', async () => {
    const { app } = createHealthApp();

    const response = await request(app).head('/health/live');

    expect(response.status).toBe(200);
    expect(response.text).toBeUndefined();
  });

  it('answers readiness with 200 and no-store when ready', async () => {
    const { app } = createHealthApp();

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ready' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each(['draining', 'database_unavailable', 'timeout'] as const)(
    'hides the reason %s behind one public 503 body',
    async (reason) => {
      const { app } = createHealthApp({ status: 'not_ready', reason });

      const response = await request(app).get('/health/ready');

      expect(response.status).toBe(503);
      expect(response.body).toEqual({ status: 'not_ready' });
      expect(response.headers['cache-control']).toBe('no-store');
    },
  );

  it('runs the checker on every readiness request', async () => {
    const { app, checkReadiness } = createHealthApp();

    await request(app).get('/health/ready');
    await request(app).get('/health/ready');

    expect(checkReadiness).toHaveBeenCalledTimes(2);
  });
});
