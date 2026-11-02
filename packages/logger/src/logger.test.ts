import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger, type LoggerOptions } from './logger.js';
import { REDACTION_CENSOR } from './redaction.js';

type LogRecord = Record<string, unknown>;

const baseOptions: LoggerOptions = {
  level: 'info',
  pretty: false,
  service: 'example-service',
  environment: 'test',
};

const captureStdout = (operation: () => void): string => {
  const chunks: string[] = [];
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });

  try {
    operation();
  } finally {
    writeSpy.mockRestore();
  }

  return chunks.join('');
};

const isLogRecord = (value: unknown): value is LogRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseLogRecords = (output: string): LogRecord[] =>
  output
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);

      if (!isLogRecord(parsed)) {
        throw new Error('Expected a structured JSON log object');
      }

      return parsed;
    });

describe('createLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const)(
    'applies the %s level',
    (level) => {
      expect(createLogger({ ...baseOptions, level }).level).toBe(level);
    },
  );

  it('writes one structured JSON record with severity, service and environment', () => {
    const output = captureStdout(() => {
      createLogger(baseOptions).info({ requestId: 'request-123' }, 'Server started');
    });
    const records = parseLogRecords(output);

    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(
      expect.objectContaining({
        severity: 'INFO',
        service: 'example-service',
        env: 'test',
        requestId: 'request-123',
        msg: 'Server started',
      }),
    );
  });

  it('writes an ISO timestamp', () => {
    const output = captureStdout(() => {
      createLogger(baseOptions).info('timestamp-test');
    });
    const [record] = parseLogRecords(output);

    expect(typeof record?.time).toBe('string');
    expect(Number.isNaN(Date.parse(String(record?.time)))).toBe(false);
  });

  it('filters messages below the configured level', () => {
    const output = captureStdout(() => {
      const logger = createLogger({ ...baseOptions, level: 'warn' });

      logger.debug('hidden-debug');
      logger.info('hidden-info');
      logger.warn('visible-warn');
      logger.error('visible-error');
    });

    expect(parseLogRecords(output).map((record) => record.msg)).toEqual([
      'visible-warn',
      'visible-error',
    ]);
  });

  it('emits nothing when the level is silent', () => {
    const output = captureStdout(() => {
      const logger = createLogger({ ...baseOptions, level: 'silent' });

      logger.fatal('hidden-fatal');
      logger.error('hidden-error');
    });

    expect(output).toBe('');
  });

  it('serializes errors under both err and error keys', () => {
    const output = captureStdout(() => {
      const logger = createLogger({ ...baseOptions, level: 'error' });

      logger.error({ err: new Error('safe err message') }, 'err-key');
      logger.error({ error: new TypeError('safe error message') }, 'error-key');
    });
    const records = parseLogRecords(output);

    expect(records[0]).toMatchObject({ err: { name: 'Error', message: 'safe err message' } });
    expect(records[1]).toMatchObject({
      error: { name: 'TypeError', message: 'safe error message' },
    });
  });

  it.each(['err', 'error'])(
    'filters a pg-like error logged under %s, dropping its detail',
    (key) => {
      const pgLikeError = Object.assign(new Error('duplicate key value'), {
        code: '23505',
        constraint: 'items_name_key',
        table: 'items',
        detail: 'Key (name)=(quoted-value-123) already exists.',
      });
      const output = captureStdout(() => {
        createLogger(baseOptions).error({ [key]: pgLikeError }, 'x');
      });
      const [record] = parseLogRecords(output);

      expect(record).toMatchObject({
        [key]: {
          name: 'Error',
          messageOmitted: true,
          code: '23505',
          constraint: 'items_name_key',
          table: 'items',
        },
      });
      expect(record).not.toHaveProperty([key, 'detail']);
      expect(output).not.toContain('quoted-value-123');
    },
  );

  it('applies the redaction policy', () => {
    const secret = 'logger-secret-that-must-not-appear';
    const output = captureStdout(() => {
      createLogger(baseOptions).info(
        {
          apiKey: secret,
          req: { headers: { authorization: secret }, body: { any: secret } },
          safeField: 'visible-value',
        },
        'redaction-integration',
      );
    });

    expect(output).not.toContain(secret);
    expect(output).toContain(REDACTION_CENSOR);
    expect(output).toContain('visible-value');
  });

  it('uses only its options, never process.env', () => {
    vi.stubEnv('NODE_ENV', 'invalid-environment');
    vi.stubEnv('LOG_LEVEL', 'invalid-level');

    const output = captureStdout(() => {
      createLogger(baseOptions).info('injected-options');
    });

    expect(parseLogRecords(output)[0]).toEqual(
      expect.objectContaining({ msg: 'injected-options', env: 'test' }),
    );
  });

  it('creates independent loggers from independent options', () => {
    const output = captureStdout(() => {
      createLogger({ ...baseOptions, service: 'api', environment: 'development' }).info(
        'api-visible',
      );
      const worker = createLogger({ ...baseOptions, service: 'worker', level: 'error' });
      worker.info('worker-hidden');
      worker.error('worker-visible');
    });

    expect(parseLogRecords(output)).toEqual([
      expect.objectContaining({ service: 'api', env: 'development', msg: 'api-visible' }),
      expect.objectContaining({ service: 'worker', msg: 'worker-visible' }),
    ]);
  });
});
