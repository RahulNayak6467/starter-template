import { describe, expect, it } from 'vitest';

import { AppError, RETRYABLE_BY_KIND, type ERROR_KIND } from './errors.js';

const ALL_KINDS: readonly ERROR_KIND[] = [
  'invalid_input',
  'not_found',
  'payload_too_large',
  'internal',
];

describe('AppError', () => {
  it('sets kind, code, message, and name', () => {
    const error = new AppError({
      kind: 'invalid_input',
      code: 'INVALID_INPUT',
      message: 'Invalid input',
    });

    expect(error.kind).toBe('invalid_input');
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe('Invalid input');
    expect(error.name).toBe('AppError');
  });

  it('keeps the cause when one is given', () => {
    const cause = new Error('underlying');

    const error = new AppError({ kind: 'internal', code: 'BOOM', message: 'Boom', cause });

    expect(error.cause).toBe(cause);
  });

  it('has no own cause property when none is given', () => {
    const error = new AppError({ kind: 'internal', code: 'BOOM', message: 'Boom' });

    expect(Object.hasOwn(error, 'cause')).toBe(false);
  });

  it('is an instance of both AppError and Error', () => {
    const error = new AppError({ kind: 'not_found', code: 'MISSING', message: 'Missing' });

    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(Error);
  });

  it.each(ALL_KINDS)('reports retryable from RETRYABLE_BY_KIND for %s', (kind) => {
    const error = new AppError({ kind, code: 'CODE', message: 'Message' });

    expect(error.retryable).toBe(RETRYABLE_BY_KIND[kind]);
  });

  it('has no retryable kind', () => {
    const retryableKinds = ALL_KINDS.filter((kind) => RETRYABLE_BY_KIND[kind]);

    expect(retryableKinds).toEqual([]);
  });
});
