import * as z from 'zod';

import { connectionUrl, integerEnv } from './fields.js';

export const databaseUrlSchema = connectionUrl(
  'DATABASE_URL',
  ['postgres:', 'postgresql:'],
  (url) => (url.pathname.length <= 1 ? ['DATABASE_URL must include a database name'] : []),
);

export const databaseEnvSchema = z.object({
  DATABASE_URL: databaseUrlSchema,
  DB_POOL_MAX: integerEnv('DB_POOL_MAX', { min: 1, max: 50, fallback: 10, unit: 'connections' }),
  DB_CONNECTION_TIMEOUT_MS: integerEnv('DB_CONNECTION_TIMEOUT_MS', {
    min: 100,
    max: 30_000,
    fallback: 5_000,
    unit: 'milliseconds',
  }),
  DB_POOL_IDLE_TIMEOUT_MS: integerEnv('DB_POOL_IDLE_TIMEOUT_MS', {
    min: 1_000,
    max: 300_000,
    fallback: 10_000,
    unit: 'milliseconds',
  }),
  DB_STATEMENT_TIMEOUT_MS: integerEnv('DB_STATEMENT_TIMEOUT_MS', {
    min: 100,
    max: 120_000,
    fallback: 15_000,
    unit: 'milliseconds',
  }),
  DB_READINESS_TIMEOUT_MS: integerEnv('DB_READINESS_TIMEOUT_MS', {
    min: 100,
    max: 5_000,
    fallback: 1_000,
    unit: 'milliseconds',
  }),
});
