import * as z from 'zod';
import { describe, expect, it, vi } from 'vitest';

import { environmentEnvSchema } from './env.js';
import { loadConfigOrExit, toConfigValidationIssues } from './load.js';

const createFakeProcess = () => {
  const stderr = { write: vi.fn<(chunk: string) => unknown>() };
  const exit = vi.fn<(code: number) => never>(() => {
    throw new Error('process.exit called');
  });

  return { stderr, exit };
};

const zodError = (schema: z.ZodType, input: unknown): unknown => {
  const result = schema.safeParse(input);
  return result.success ? null : result.error;
};

describe('toConfigValidationIssues', () => {
  it('returns field names and reasons for every issue', () => {
    const schema = z.object({
      A: z.string({ error: 'A is required' }),
      B: z.object({ C: z.string({ error: 'C is required' }) }),
    });

    expect(toConfigValidationIssues(zodError(schema, { B: {} }))).toEqual([
      { field: 'A', reason: 'A is required' },
      { field: 'B.C', reason: 'C is required' },
    ]);
  });

  it('uses "configuration" for an issue at the root', () => {
    const schema = z.object({}).superRefine((_value, context) => {
      context.addIssue({ code: 'custom', message: 'root problem' });
    });

    expect(toConfigValidationIssues(zodError(schema, {}))).toEqual([
      { field: 'configuration', reason: 'root problem' },
    ]);
  });

  it('returns null for an error that is not from Zod', () => {
    expect(toConfigValidationIssues(new Error('other'))).toBeNull();
  });
});

describe('loadConfigOrExit', () => {
  it('returns the loaded config without writing or exiting', () => {
    const processTarget = createFakeProcess();
    const config = { environment: 'test' };

    expect(loadConfigOrExit('test-service', () => config, processTarget)).toBe(config);
    expect(processTarget.stderr.write).not.toHaveBeenCalled();
    expect(processTarget.exit).not.toHaveBeenCalled();
  });

  it('writes one FATAL config_invalid line without the rejected value and exits 1', () => {
    const processTarget = createFakeProcess();
    const secret = 'value-that-must-not-appear';
    const load = () => environmentEnvSchema.parse({ NODE_ENV: secret });

    expect(() => loadConfigOrExit('test-service', load, processTarget)).toThrow(
      'process.exit called',
    );

    expect(processTarget.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(processTarget.stderr.write).toHaveBeenCalledOnce();
    const output = String(processTarget.stderr.write.mock.calls[0]?.[0]);
    expect(output.endsWith('\n')).toBe(true);
    expect(output.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(output)).toEqual({
      severity: 'FATAL',
      service: 'test-service',
      event: 'config_invalid',
      issues: [{ field: 'NODE_ENV', reason: 'NODE_ENV must be development, test, or production' }],
      msg: 'Invalid configuration; refusing to start',
    });
    expect(output).not.toContain(secret);
  });

  it('rethrows an error that is not from Zod without writing or exiting', () => {
    const processTarget = createFakeProcess();
    const failure = new Error('unexpected');

    expect(() =>
      loadConfigOrExit(
        'test-service',
        () => {
          throw failure;
        },
        processTarget,
      ),
    ).toThrow(failure);
    expect(processTarget.stderr.write).not.toHaveBeenCalled();
    expect(processTarget.exit).not.toHaveBeenCalled();
  });
});
