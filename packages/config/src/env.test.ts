import * as z from 'zod';
import { describe, expect, it } from 'vitest';

import { applyLoggerRules, environmentEnvSchema, loggerEnvSchema } from './env.js';

const messages = (schema: z.ZodType, input: unknown): string[] => {
  const result = schema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe('environmentEnvSchema', () => {
  it('requires NODE_ENV instead of defaulting to a less strict environment', () => {
    expect(messages(environmentEnvSchema, {})).toEqual(['NODE_ENV is required']);
  });

  it.each(['development', 'test', 'production'] as const)('accepts NODE_ENV=%s', (value) => {
    expect(environmentEnvSchema.parse({ NODE_ENV: value })).toEqual({ NODE_ENV: value });
  });

  it.each(['staging', 'prod', '', 'DEVELOPMENT'])('rejects NODE_ENV=%j', (value) => {
    expect(messages(environmentEnvSchema, { NODE_ENV: value })).toEqual([
      'NODE_ENV must be development, test, or production',
    ]);
  });

  it('never puts the supplied value in an issue', () => {
    const value = 'value-that-must-not-appear';
    const result = environmentEnvSchema.safeParse({ NODE_ENV: value });

    expect(JSON.stringify(result.error?.issues)).not.toContain(value);
  });
});

describe('loggerEnvSchema', () => {
  it('defaults to info with pretty output off', () => {
    expect(loggerEnvSchema.parse({})).toEqual({ LOG_LEVEL: 'info', LOG_PRETTY: false });
  });

  it.each(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const)(
    'accepts LOG_LEVEL=%s',
    (level) => {
      expect(loggerEnvSchema.parse({ LOG_LEVEL: level }).LOG_LEVEL).toBe(level);
    },
  );

  it.each(['verbose', 'INFO', 'off', ''])('rejects LOG_LEVEL=%j', (level) => {
    expect(loggerEnvSchema.safeParse({ LOG_LEVEL: level }).success).toBe(false);
  });

  it.each([
    ['true', true],
    ['false', false],
  ] as const)('reads LOG_PRETTY=%s as %s', (value, expected) => {
    expect(loggerEnvSchema.parse({ LOG_PRETTY: value }).LOG_PRETTY).toBe(expected);
  });

  it.each(['yes', '1', 'TRUE', ''])('rejects LOG_PRETTY=%j', (value) => {
    expect(messages(loggerEnvSchema, { LOG_PRETTY: value })).toEqual([
      'LOG_PRETTY must be true or false',
    ]);
  });
});

describe('applyLoggerRules', () => {
  const schema = z
    .object({ ...environmentEnvSchema.shape, ...loggerEnvSchema.shape })
    .superRefine(applyLoggerRules);

  it('rejects pretty logging in production', () => {
    expect(messages(schema, { NODE_ENV: 'production', LOG_PRETTY: 'true' })).toEqual([
      'Pretty logging is not allowed in production',
    ]);
  });

  it('allows pretty logging in development', () => {
    expect(messages(schema, { NODE_ENV: 'development', LOG_PRETTY: 'true' })).toEqual([]);
  });

  it.each(['development', 'production'])('rejects silent logging in %s', (environment) => {
    expect(messages(schema, { NODE_ENV: environment, LOG_LEVEL: 'silent' })).toEqual([
      'Silent logging is allowed only during tests',
    ]);
  });

  it('allows silent logging in tests', () => {
    expect(messages(schema, { NODE_ENV: 'test', LOG_LEVEL: 'silent' })).toEqual([]);
  });

  it('reports both issues at their fields', () => {
    const result = schema.safeParse({
      NODE_ENV: 'production',
      LOG_PRETTY: 'true',
      LOG_LEVEL: 'silent',
    });

    expect(result.error?.issues.map((issue) => issue.path)).toEqual([
      ['LOG_PRETTY'],
      ['LOG_LEVEL'],
    ]);
  });
});
