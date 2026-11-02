import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { parseRequest, RequestValidationError } from './validation.js';

describe('parseRequest', () => {
  const schema = z.object({ limit: z.coerce.number().int().min(1).default(20) });

  it('returns the parsed output, with defaults and conversions applied', () => {
    expect(parseRequest(schema, {})).toEqual({ limit: 20 });
    expect(parseRequest(schema, { limit: '5' })).toEqual({ limit: 5 });
  });

  it('throws a RequestValidationError carrying every issue', () => {
    let thrown: unknown;

    try {
      parseRequest(z.object({ a: z.string(), b: z.number() }), {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RequestValidationError);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({
      name: 'RequestValidationError',
      issues: [expect.objectContaining({ path: ['a'] }), expect.objectContaining({ path: ['b'] })],
    });
  });

  it('never throws a bare ZodError, so the error middleware can tell request input from our data', () => {
    expect(() => parseRequest(schema, { limit: 0 })).toThrow(RequestValidationError);
    expect(() => parseRequest(schema, { limit: 0 })).not.toThrow(z.ZodError);
  });
});
