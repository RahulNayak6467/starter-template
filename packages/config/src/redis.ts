import * as z from 'zod';

import { connectionUrl, integerEnv } from './fields.js';

const checkRedisUrl = (url: URL): readonly string[] => {
  const problems: string[] = [];

  if (url.pathname !== '' && url.pathname !== '/' && url.pathname !== '/0') {
    problems.push('REDIS_URL must not select a database other than 0');
  }

  // ioredis reads client options from the query string, including enableOfflineQueue.
  if (url.search !== '' || url.hash !== '') {
    problems.push('REDIS_URL must not include query parameters or a fragment');
  }

  return problems;
};

export const redisUrlSchema = connectionUrl('REDIS_URL', ['redis:', 'rediss:'], checkRedisUrl);

export const redisEnvSchema = z.object({
  REDIS_URL: redisUrlSchema,
  REDIS_COMMAND_TIMEOUT_MS: integerEnv('REDIS_COMMAND_TIMEOUT_MS', {
    min: 10,
    max: 5_000,
    fallback: 100,
    unit: 'milliseconds',
  }),
  REDIS_CONNECT_TIMEOUT_MS: integerEnv('REDIS_CONNECT_TIMEOUT_MS', {
    min: 100,
    max: 30_000,
    fallback: 2_000,
    unit: 'milliseconds',
  }),
});
