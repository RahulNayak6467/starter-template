import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DatabaseLogger } from './pool.js';

const poolDoubles = vi.hoisted(() => ({
  handlers: new Map<string, (...arguments_: unknown[]) => void>(),
  construct: vi.fn<(options: unknown) => void>(),
}));

vi.mock('pg', () => ({
  Pool: class PoolDouble {
    readonly totalCount = 4;
    readonly idleCount = 2;
    readonly waitingCount = 1;

    constructor(options: unknown) {
      poolDoubles.construct(options);
    }

    on(event: string, listener: (...arguments_: unknown[]) => void): this {
      poolDoubles.handlers.set(event, listener);
      return this;
    }
  },
}));

const { createPool } = await import('./pool.js');

const PASSWORD = ['pool', 'test', 'pass'].join('-');

const options = {
  url: `postgresql://app:${PASSWORD}@127.0.0.1:5432/app_test`,
  poolMax: 12,
  connectionTimeoutMs: 4_000,
  idleTimeoutMs: 11_000,
  statementTimeoutMs: 16_000,
  applicationName: 'example-api',
};

const logger = {
  debug: vi.fn<DatabaseLogger['debug']>(),
  info: vi.fn<DatabaseLogger['info']>(),
  error: vi.fn<DatabaseLogger['error']>(),
} satisfies DatabaseLogger;

const requireHandler = (event: string): ((...arguments_: unknown[]) => void) => {
  const handler = poolDoubles.handlers.get(event);

  if (handler === undefined) {
    throw new Error(`Expected a ${event} pool event handler`);
  }

  return handler;
};

describe('createPool', () => {
  beforeEach(() => {
    poolDoubles.handlers.clear();
  });

  it('bounds the pool size and every wait', () => {
    createPool(options, logger);

    expect(poolDoubles.construct).toHaveBeenCalledOnce();
    expect(poolDoubles.construct).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: options.url,
        max: 12,
        connectionTimeoutMillis: 4_000,
        idleTimeoutMillis: 11_000,
        statement_timeout: 16_000,
        application_name: 'example-api',
      }),
    );
  });

  it('sets the client-side query deadline above the server-side statement timeout', () => {
    createPool({ ...options, statementTimeoutMs: 5_000 }, logger);

    expect(poolDoubles.construct).toHaveBeenCalledWith(
      expect.objectContaining({ statement_timeout: 5_000, query_timeout: 7_000 }),
    );
  });

  it('turns TCP keep-alive on so a silently dropped connection is noticed', () => {
    createPool(options, logger);

    expect(poolDoubles.construct).toHaveBeenCalledWith(
      expect.objectContaining({ keepAlive: true, keepAliveInitialDelayMillis: 10_000 }),
    );
  });

  it('logs only non-secret settings when the pool is configured', () => {
    createPool(options, logger);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'postgres_pool_configured', maxConnections: 12 }),
      expect.any(String),
    );
    const serialized = JSON.stringify(logger.info.mock.calls);
    expect(serialized).not.toContain(options.url);
    expect(serialized).not.toContain(PASSWORD);
  });

  it('handles an idle-client error without throwing and logs the pool state', () => {
    createPool(options, logger);
    const error = Object.assign(new Error('connection terminated unexpectedly'), {
      code: '57P01',
    });

    expect(() => {
      requireHandler('error')(error);
    }).not.toThrow();
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0]?.[0]).toMatchObject({
      event: 'postgres_idle_client_error',
      errorDetails: { code: '57P01' },
      totalConnections: 4,
      idleConnections: 2,
      waitingRequests: 1,
    });
  });

  it('never logs the connection string carried by an idle-client error', () => {
    createPool(options, logger);
    const error = Object.assign(new Error('connection terminated unexpectedly'), {
      client: { connectionParameters: { connectionString: options.url } },
    });

    requireHandler('error')(error);

    const serialized = JSON.stringify(logger.error.mock.calls);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain('connectionParameters');
  });
});
