import { Router, type Response } from 'express';
import * as z from 'zod';

import type { ReadinessChecker } from './readiness.js';

export const liveResponseSchema = z
  .object({ status: z.literal('ok') })
  .meta({ id: 'LiveResponse', description: 'The process is up and serving HTTP.' });

export const readyResponseSchema = z
  .object({ status: z.literal('ready') })
  .meta({ id: 'ReadyResponse', description: 'The API can serve traffic.' });

export const notReadyResponseSchema = z.object({ status: z.literal('not_ready') }).meta({
  id: 'NotReadyResponse',
  description: 'The API should not receive traffic: it is draining or PostgreSQL or Redis is down.',
});

type LiveResponse = z.infer<typeof liveResponseSchema>;
type ReadyResponse = z.infer<typeof readyResponseSchema>;
type NotReadyResponse = z.infer<typeof notReadyResponseSchema>;

export const createHealthRoutes = (checkReadiness: ReadinessChecker): Router => {
  const router = Router();

  // Liveness checks no dependency: a database outage must not restart the API.
  router.get('/live', (_req, res: Response<LiveResponse>) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ status: 'ok' });
  });

  router.get('/ready', async (_req, res: Response<ReadyResponse | NotReadyResponse>) => {
    const result = await checkReadiness();

    res.setHeader('Cache-Control', 'no-store');
    if (result.status === 'ready') {
      res.status(200).json({ status: 'ready' });
      return;
    }
    res.status(503).json({ status: 'not_ready' });
  });

  return router;
};
