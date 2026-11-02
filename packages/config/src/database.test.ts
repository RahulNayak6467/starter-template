import type * as z from 'zod';
import { describe, expect, it } from 'vitest';

import { databaseEnvSchema, databaseUrlSchema } from './database.js';

const VALID_URL = 'postgres://app:local-pass@127.0.0.1:5432/app';

const messages = (schema: z.ZodType, input: unknown): string[] => {
  const result = schema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe('databaseUrlSchema', () => {
  it.each([VALID_URL, 'postgresql://app@db.internal/app'])('accepts %j', (value) => {
    expect(databaseUrlSchema.parse(value)).toBe(value);
  });

  it.each(['redis://127.0.0.1:6379/0', 'mysql://app@127.0.0.1:3306/app'])(
    'rejects the non-PostgreSQL URL %j',
    (value) => {
      expect(messages(databaseUrlSchema, value)).toEqual([
        'DATABASE_URL must use the postgres:// or postgresql:// protocol',
      ]);
    },
  );

  it.each(['postgres://127.0.0.1:5432', 'postgres://127.0.0.1:5432/'])(
    'rejects %j without a database name',
    (value) => {
      expect(messages(databaseUrlSchema, value)).toEqual([
        'DATABASE_URL must include a database name',
      ]);
    },
  );
});

describe('databaseEnvSchema', () => {
  it('returns the documented defaults when only DATABASE_URL is set', () => {
    expect(databaseEnvSchema.parse({ DATABASE_URL: VALID_URL })).toEqual({
      DATABASE_URL: VALID_URL,
      DB_POOL_MAX: 10,
      DB_CONNECTION_TIMEOUT_MS: 5_000,
      DB_POOL_IDLE_TIMEOUT_MS: 10_000,
      DB_STATEMENT_TIMEOUT_MS: 15_000,
      DB_READINESS_TIMEOUT_MS: 1_000,
    });
  });

  it('reports a missing DATABASE_URL at its field', () => {
    const result = databaseEnvSchema.safeParse({});

    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ['DATABASE_URL'], message: 'DATABASE_URL is required' }),
    ]);
  });

  it.each([
    ['DB_POOL_MAX', '0', '51'],
    ['DB_CONNECTION_TIMEOUT_MS', '99', '30001'],
    ['DB_POOL_IDLE_TIMEOUT_MS', '999', '300001'],
    ['DB_STATEMENT_TIMEOUT_MS', '99', '120001'],
    ['DB_READINESS_TIMEOUT_MS', '99', '5001'],
  ])('enforces the bounds of %s', (field, below, above) => {
    expect(databaseEnvSchema.safeParse({ DATABASE_URL: VALID_URL, [field]: below }).success).toBe(
      false,
    );
    expect(databaseEnvSchema.safeParse({ DATABASE_URL: VALID_URL, [field]: above }).success).toBe(
      false,
    );
  });

  it('ignores unrelated variables', () => {
    expect(databaseEnvSchema.parse({ DATABASE_URL: VALID_URL, UNRELATED: 'x' })).not.toHaveProperty(
      'UNRELATED',
    );
  });
});
