import type { Logger } from '@starter/logger';
import type { Clock } from '@starter/shared';
import express, { type Express } from 'express';

import { createHealthRoutes } from '../health/health.routes.js';
import type { ReadinessChecker } from '../health/readiness.js';
import { createErrorMiddleware } from './error.middleware.js';
import { createBodyLimitMiddleware, notFoundMiddleware } from './helper-error.middleware.js';
import { createRequestIdMiddleware } from './request-id.middleware.js';
import { createRequestLoggerMiddleware } from './request-logger.middleware.js';

export const MAX_REQUEST_BODY_BYTES = 1_048_576;

export interface AppDependencies {
  readonly logger: Logger;
  readonly clock: Clock;
  readonly checkReadiness: ReadinessChecker;
}

export const createApp = ({ logger, clock, checkReadiness }: AppDependencies): Express => {
  const app = express();
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  // Before body parsing, so parser errors carry the request ID.
  app.use(createRequestIdMiddleware(logger));
  app.use(createRequestLoggerMiddleware(clock, { quietPaths: ['/health/live', '/health/ready'] }));
  app.use(createBodyLimitMiddleware(MAX_REQUEST_BODY_BYTES));
  app.use(express.json({ limit: MAX_REQUEST_BODY_BYTES }));

  app.use('/health', createHealthRoutes(checkReadiness));

  app.use(notFoundMiddleware);
  app.use(createErrorMiddleware(logger));

  return app;
};
