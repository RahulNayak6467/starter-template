import type * as z from 'zod';
import { describe, expect, it } from 'vitest';

import { redisEnvSchema, redisUrlSchema } from './redis.js';

const VALID_URL = 'redis://default:local-pass@127.0.0.1:6379/0';

const messages = (schema: z.ZodType, input: unknown): string[] => {
  const result = schema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe('redisUrlSchema', () => {
  it.each([
    VALID_URL,
    'redis://127.0.0.1:6379',
    'redis://127.0.0.1:6379/',
    'rediss://cache.example:6380/0',
  ])('accepts %j', (value) => {
    expect(redisUrlSchema.parse(value)).toBe(value);
  });

  it.each(['http://127.0.0.1:6379', 'postgres://app@127.0.0.1:5432/app'])(
    'rejects the non-Redis URL %j',
    (value) => {
      expect(messages(redisUrlSchema, value)).toEqual([
        'REDIS_URL must use the redis:// or rediss:// protocol',
      ]);
    },
  );

  it.each(['redis://127.0.0.1:6379/1', 'redis://127.0.0.1:6379/abc'])(
    'rejects %j, which selects a database other than 0',
    (value) => {
      expect(messages(redisUrlSchema, value)).toEqual([
        'REDIS_URL must not select a database other than 0',
      ]);
    },
  );

  it.each(['redis://127.0.0.1:6379/0?enableOfflineQueue=true', 'redis://127.0.0.1:6379/0#x'])(
    'rejects %j, which could override client options',
    (value) => {
      expect(messages(redisUrlSchema, value)).toEqual([
        'REDIS_URL must not include query parameters or a fragment',
      ]);
    },
  );

  it('reports both problems when a URL has a database and a query string', () => {
    expect(messages(redisUrlSchema, 'redis://127.0.0.1:6379/2?db=3')).toEqual([
      'REDIS_URL must not select a database other than 0',
      'REDIS_URL must not include query parameters or a fragment',
    ]);
  });
});

describe('redisEnvSchema', () => {
  it('returns the documented defaults when only REDIS_URL is set', () => {
    expect(redisEnvSchema.parse({ REDIS_URL: VALID_URL })).toEqual({
      REDIS_URL: VALID_URL,
      REDIS_COMMAND_TIMEOUT_MS: 100,
      REDIS_CONNECT_TIMEOUT_MS: 2_000,
    });
  });

  it('reports a missing REDIS_URL at its field', () => {
    const result = redisEnvSchema.safeParse({});

    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ['REDIS_URL'], message: 'REDIS_URL is required' }),
    ]);
  });

  it.each([
    ['REDIS_COMMAND_TIMEOUT_MS', '9', '5001'],
    ['REDIS_CONNECT_TIMEOUT_MS', '99', '30001'],
  ])('enforces the bounds of %s', (field, below, above) => {
    expect(redisEnvSchema.safeParse({ REDIS_URL: VALID_URL, [field]: below }).success).toBe(false);
    expect(redisEnvSchema.safeParse({ REDIS_URL: VALID_URL, [field]: above }).success).toBe(false);
  });
});
