import { QUERY_TIMEOUT_MARGIN_MS } from '@starter/database';
import { QUIT_TIMEOUT_MS } from '@starter/redis';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

import { apiEnvSchema, loadConfig, parseConfig, SHUTDOWN_MARGIN_MS } from './config.js';

const databaseUrl = 'postgres://starter_test:test-only@127.0.0.1:5461/starter_test';
const redisUrl = 'redis://default:test-only@127.0.0.1:6411/0';

const requiredInput = {
  NODE_ENV: 'development',
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
} as const;

const expectedDefaults = {
  environment: 'development',
  logging: { level: 'info', pretty: false },
  server: {
    port: 8000,
    requestTimeoutMs: 30_000,
    headersTimeoutMs: 20_000,
    keepAliveTimeoutMs: 5_000,
    shutdownTimeoutMs: 20_000,
  },
  database: {
    url: databaseUrl,
    poolMax: 10,
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 10_000,
    statementTimeoutMs: 15_000,
    readinessTimeoutMs: 1_000,
  },
  redis: { url: redisUrl, commandTimeoutMs: 100, connectTimeoutMs: 2_000 },
} as const;

const explicitInput = {
  ...requiredInput,
  NODE_ENV: 'test',
  LOG_LEVEL: 'debug',
  LOG_PRETTY: 'true',
  PORT: '8080',
  HTTP_REQUEST_TIMEOUT_MS: '90000',
  HTTP_HEADERS_TIMEOUT_MS: '45000',
  HTTP_KEEP_ALIVE_TIMEOUT_MS: '7000',
  SHUTDOWN_TIMEOUT_MS: '50000',
  DB_POOL_MAX: '20',
  DB_CONNECTION_TIMEOUT_MS: '2000',
  DB_POOL_IDLE_TIMEOUT_MS: '30000',
  DB_STATEMENT_TIMEOUT_MS: '45000',
  DB_READINESS_TIMEOUT_MS: '750',
  REDIS_COMMAND_TIMEOUT_MS: '250',
  REDIS_CONNECT_TIMEOUT_MS: '4000',
} as const;

const expectedExplicit = {
  environment: 'test',
  logging: { level: 'debug', pretty: true },
  server: {
    port: 8080,
    requestTimeoutMs: 90_000,
    headersTimeoutMs: 45_000,
    keepAliveTimeoutMs: 7_000,
    shutdownTimeoutMs: 50_000,
  },
  database: {
    url: databaseUrl,
    poolMax: 20,
    connectionTimeoutMs: 2_000,
    idleTimeoutMs: 30_000,
    statementTimeoutMs: 45_000,
    readinessTimeoutMs: 750,
  },
  redis: { url: redisUrl, commandTimeoutMs: 250, connectTimeoutMs: 4_000 },
} as const;

const failingFields = (input: Record<string, string>): string[] => {
  const result = apiEnvSchema.safeParse({ ...requiredInput, ...input });
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
};

const issuesFor = (input: Record<string, string>) => {
  const result = apiEnvSchema.safeParse({ ...requiredInput, ...input });
  return result.success ? [] : result.error.issues;
};

describe('API configuration', () => {
  it('fills every default when only the required variables are set', () => {
    expect(parseConfig(requiredInput)).toEqual(expectedDefaults);
  });

  it('converts every explicit variable into the nested config', () => {
    expect(parseConfig(explicitInput)).toEqual(expectedExplicit);
  });

  it('requires NODE_ENV, DATABASE_URL and REDIS_URL', () => {
    const result = apiEnvSchema.safeParse({});

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.')).sort()).toEqual([
      'DATABASE_URL',
      'NODE_ENV',
      'REDIS_URL',
    ]);
  });

  it('ignores unrelated environment variables', () => {
    expect(parseConfig({ ...requiredInput, SHELL: '/bin/zsh', HOME: '/home/dev' })).toEqual(
      expectedDefaults,
    );
  });

  it.each(['0', '65536', '80.5', '0x1F90', ' 8080'])('rejects PORT=%j', (port) => {
    expect(failingFields({ PORT: port })).toEqual(['PORT']);
  });

  describe('server timeouts', () => {
    const timeouts = [
      { field: 'HTTP_REQUEST_TIMEOUT_MS', min: 1_000, max: 300_000 },
      { field: 'HTTP_HEADERS_TIMEOUT_MS', min: 1_000, max: 120_000 },
      { field: 'HTTP_KEEP_ALIVE_TIMEOUT_MS', min: 1_000, max: 120_000 },
      { field: 'SHUTDOWN_TIMEOUT_MS', min: 5_000, max: 120_000 },
    ] as const;

    // Small database timeouts and a large request timeout keep the cross-field rules quiet.
    const quiet = {
      HTTP_REQUEST_TIMEOUT_MS: '300000',
      HTTP_HEADERS_TIMEOUT_MS: '1000',
      DB_STATEMENT_TIMEOUT_MS: '100',
      DB_READINESS_TIMEOUT_MS: '100',
    };

    it.each(timeouts)('accepts both boundaries of $field', ({ field, min, max }) => {
      expect(failingFields({ ...quiet, [field]: String(min) })).toEqual([]);
      expect(failingFields({ ...quiet, [field]: String(max) })).toEqual([]);
    });

    it.each(timeouts)('rejects one past each boundary of $field', ({ field, min, max }) => {
      expect(failingFields({ ...quiet, [field]: String(min - 1) })).toContain(field);
      expect(failingFields({ ...quiet, [field]: String(max + 1) })).toContain(field);
    });

    it('rejects a timeout past the Node timer limit instead of letting it fire after 1 ms', () => {
      expect(failingFields({ SHUTDOWN_TIMEOUT_MS: '3000000000' })).toEqual(['SHUTDOWN_TIMEOUT_MS']);
    });
  });

  describe('rules across fields', () => {
    it.each([
      ['59999', true],
      ['60000', true],
      ['60001', false],
    ])('header timeout %s against a 60000 request timeout → valid=%s', (headers, valid) => {
      expect(
        failingFields({ HTTP_REQUEST_TIMEOUT_MS: '60000', HTTP_HEADERS_TIMEOUT_MS: headers }),
      ).toEqual(valid ? [] : ['HTTP_HEADERS_TIMEOUT_MS']);
    });

    it.each([
      ['999', true],
      ['1000', true],
      ['1001', false],
    ])('readiness timeout %s against a 1000 statement timeout → valid=%s', (readiness, valid) => {
      expect(
        failingFields({ DB_STATEMENT_TIMEOUT_MS: '1000', DB_READINESS_TIMEOUT_MS: readiness }),
      ).toEqual(valid ? [] : ['DB_READINESS_TIMEOUT_MS']);
    });

    it('builds the shutdown margin from the query timeout margin and the Redis quit timeout', () => {
      expect(SHUTDOWN_MARGIN_MS).toBe(QUERY_TIMEOUT_MARGIN_MS + QUIT_TIMEOUT_MS);
    });

    it.each([
      ['equal to statement + margin', String(15_000 + SHUTDOWN_MARGIN_MS), false],
      ['one above statement + margin', String(15_000 + SHUTDOWN_MARGIN_MS + 1), true],
    ])('shutdown timeout %s → valid=%s', (_label, shutdown, valid) => {
      expect(
        failingFields({ DB_STATEMENT_TIMEOUT_MS: '15000', SHUTDOWN_TIMEOUT_MS: shutdown }),
      ).toEqual(valid ? [] : ['SHUTDOWN_TIMEOUT_MS']);
    });

    it('names the margin in the shutdown rule message', () => {
      expect(issuesFor({ DB_STATEMENT_TIMEOUT_MS: '45000', SHUTDOWN_TIMEOUT_MS: '10000' })).toEqual(
        [
          expect.objectContaining({
            path: ['SHUTDOWN_TIMEOUT_MS'],
            message: `Shutdown timeout must exceed database statement timeout plus ${String(SHUTDOWN_MARGIN_MS)} ms`,
          }),
        ],
      );
    });

    it('keeps the defaults inside the shutdown rule', () => {
      const { server, database } = parseConfig(requiredInput);

      expect(server.shutdownTimeoutMs).toBeGreaterThan(
        database.statementTimeoutMs + SHUTDOWN_MARGIN_MS,
      );
    });

    it('applies the shared logger rules after merging', () => {
      expect(failingFields({ NODE_ENV: 'production', LOG_PRETTY: 'true' })).toEqual(['LOG_PRETTY']);
      expect(failingFields({ NODE_ENV: 'production', LOG_LEVEL: 'silent' })).toEqual(['LOG_LEVEL']);
    });
  });

  it('freezes the whole config', () => {
    const config = parseConfig(requiredInput);

    expect(Object.isFrozen(config)).toBe(true);
    for (const section of [config.logging, config.server, config.database, config.redis]) {
      expect(Object.isFrozen(section)).toBe(true);
    }
  });

  it('reads only the injected input, not process.env', () => {
    vi.stubEnv('PORT', '65535');

    expect(parseConfig(requiredInput).server.port).toBe(8000);
  });

  it('loadConfig reads process.env and throws a ZodError when it is invalid', () => {
    for (const [key, value] of Object.entries(explicitInput)) {
      vi.stubEnv(key, value);
    }
    expect(loadConfig()).toEqual(expectedExplicit);

    vi.stubEnv('PORT', '70000');
    expect(() => loadConfig()).toThrow(z.ZodError);
  });
});
