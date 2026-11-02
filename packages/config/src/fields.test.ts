import type * as z from 'zod';
import { describe, expect, it } from 'vitest';

import { connectionUrl, integerEnv } from './fields.js';

const messages = (schema: z.ZodType, input: unknown): string[] => {
  const result = schema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe('integerEnv', () => {
  const schema = integerEnv('TIMEOUT_MS', {
    min: 100,
    max: 5_000,
    fallback: 1_000,
    unit: 'milliseconds',
  });

  it('uses the fallback when the value is missing', () => {
    expect(schema.parse(undefined)).toBe(1_000);
  });

  it('converts a digit string into a number', () => {
    expect(schema.parse('2500')).toBe(2_500);
  });

  it('accepts both boundaries', () => {
    expect(schema.parse('100')).toBe(100);
    expect(schema.parse('5000')).toBe(5_000);
  });

  it('rejects a value below the minimum with a readable message', () => {
    expect(messages(schema, '99')).toEqual(['TIMEOUT_MS must be at least 100 milliseconds']);
  });

  it('rejects a value above the maximum with a readable message', () => {
    expect(messages(schema, '5001')).toEqual(['TIMEOUT_MS must not exceed 5,000 milliseconds']);
  });

  it.each(['1.5', '0x10', '1e3', ' 200', '200 ', '-200', '', 'abc', 'Infinity', 'NaN'])(
    'rejects %j as not a whole number',
    (value) => {
      expect(messages(schema, value)).toEqual([
        'TIMEOUT_MS must be a whole number of milliseconds',
      ]);
    },
  );

  it('leaves the unit out of the message when none is given', () => {
    const port = integerEnv('PORT', { min: 1, max: 65_535, fallback: 8000 });

    expect(messages(port, 'abc')).toEqual(['PORT must be a whole number']);
    expect(messages(port, '0')).toEqual(['PORT must be at least 1']);
  });
});

describe('connectionUrl', () => {
  const schema = connectionUrl('STORE_URL', ['store:', 'stores:']);

  it.each(['store://127.0.0.1:1234', 'stores://user:pass@host.example/x'])(
    'accepts %j',
    (value) => {
      expect(schema.parse(value)).toBe(value);
    },
  );

  it('rejects a missing value with one readable issue', () => {
    expect(messages(schema, undefined)).toEqual(['STORE_URL is required']);
  });

  it('rejects an empty value with one readable issue', () => {
    expect(messages(schema, '')).toEqual(['STORE_URL is required']);
  });

  it('rejects a value that is not a URL', () => {
    expect(messages(schema, 'not-a-url')).toEqual(['STORE_URL must be a valid connection URL']);
  });

  it('rejects a protocol outside the allowed list', () => {
    expect(messages(schema, 'http://127.0.0.1:1234')).toEqual([
      'STORE_URL must use the store:// or stores:// protocol',
    ]);
  });

  it('rejects a URL without a hostname', () => {
    expect(messages(schema, 'store://')).toEqual(['STORE_URL must include a hostname']);
  });

  it('adds the issues returned by the extra check', () => {
    const strict = connectionUrl('STORE_URL', ['store:'], (url) =>
      url.port === '' ? ['STORE_URL must include a port'] : [],
    );

    expect(messages(strict, 'store://host.example')).toEqual(['STORE_URL must include a port']);
    expect(messages(strict, 'store://host.example:1234')).toEqual([]);
  });

  it('never puts the supplied URL or its password in an issue', () => {
    const password = ['hidden', 'pass', '42'].join('-');
    const result = schema.safeParse(`http://user:${password}@127.0.0.1:1234`);

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain(password);
  });
});
