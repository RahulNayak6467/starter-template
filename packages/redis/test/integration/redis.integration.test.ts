import { setTimeout as sleep } from 'node:timers/promises';

import { Redis } from 'ioredis';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createRedisClient,
  type RedisConfig,
  type RedisConnection,
  type RedisLogger,
} from '../../src/index.js';
import { findClosedPort, requireTestRedisUrl } from '../support/test-redis.js';

const createLogger = () =>
  ({
    debug: vi.fn<RedisLogger['debug']>(),
    info: vi.fn<RedisLogger['info']>(),
    warn: vi.fn<RedisLogger['warn']>(),
    error: vi.fn<RedisLogger['error']>(),
  }) satisfies RedisLogger;

const loggedEvent = (event: string) =>
  [expect.objectContaining({ component: 'redis', event }), expect.any(String)] as const;

describe('real Redis client', () => {
  let redisUrl: string;
  const openConnections: RedisConnection[] = [];
  const openAdminClients: Redis[] = [];

  beforeAll(() => {
    redisUrl = requireTestRedisUrl();
  });

  afterEach(() => {
    for (const connection of openConnections.splice(0)) connection.redisClient.disconnect();
    for (const admin of openAdminClients.splice(0)) admin.disconnect();
  });

  const connect = (logger: RedisLogger, overrides: Partial<RedisConfig> = {}): RedisConnection => {
    const connection = createRedisClient(
      { url: redisUrl, commandTimeoutMs: 500, connectTimeoutMs: 1_000, ...overrides },
      logger,
    );
    openConnections.push(connection);
    return connection;
  };

  const connectReady = async (logger: RedisLogger): Promise<RedisConnection> => {
    const connection = connect(logger);
    await vi.waitFor(() => {
      expect(connection.redisClient.status).toBe('ready');
    });
    return connection;
  };

  const connectUnreachable = async (logger: RedisLogger): Promise<RedisConnection> => {
    const port = await findClosedPort();
    return connect(logger, { url: `redis://127.0.0.1:${String(port)}` });
  };

  it('connects, logs redis_connected once and runs a command', async () => {
    const logger = createLogger();
    const { redisClient } = await connectReady(logger);

    await expect(redisClient.ping()).resolves.toBe('PONG');
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(...loggedEvent('redis_connected'));
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('warns once while retrying an unreachable server many times', async () => {
    const logger = createLogger();
    const { redisClient } = await connectUnreachable(logger);
    const attempts = vi.fn();
    redisClient.on('reconnecting', attempts);

    await sleep(4_500);

    expect(attempts.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      ...loggedEvent('redis_unavailable_at_startup'),
    );
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
      errorDetails: { code: 'ECONNREFUSED' },
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('rejects a command at once instead of queueing it while Redis is unreachable', async () => {
    const logger = createLogger();
    const { redisClient } = await connectUnreachable(logger);
    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledOnce();
    });

    const startedAt = performance.now();
    await expect(redisClient.get('any-key')).rejects.toThrow();

    expect(performance.now() - startedAt).toBeLessThan(200);
  });

  it('treats a wrong password as unavailable and never logs either password', async () => {
    const logger = createLogger();
    const realPassword = decodeURIComponent(new URL(redisUrl).password);
    const wrongPassword = ['wrong', 'pass', 'for', 'test'].join('-');
    const wrongUrl = new URL(redisUrl);
    wrongUrl.password = wrongPassword;
    connect(logger, { url: wrongUrl.toString() });

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(...loggedEvent('redis_unavailable_at_startup'));
    });
    await sleep(2_500);

    expect(realPassword.length).toBeGreaterThan(0);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.info).not.toHaveBeenCalled();
    const serialized = JSON.stringify([
      ...logger.debug.mock.calls,
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
    ]);
    expect(serialized).not.toContain(wrongPassword);
    expect(serialized).not.toContain(realPassword);
  });

  it('logs one outage and one restore when the server drops the connection', async () => {
    const logger = createLogger();
    const { redisClient } = await connectReady(logger);
    const clientId = await redisClient.client('ID');
    const admin = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    openAdminClients.push(admin);

    await admin.client('KILL', 'ID', String(clientId));

    await vi.waitFor(
      () => {
        expect(logger.info).toHaveBeenCalledWith(...loggedEvent('redis_connection_restored'));
      },
      { timeout: 5_000 },
    );
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(...loggedEvent('redis_connection_lost'));
    const restored = logger.info.mock.calls.find(
      ([fields]) => fields.event === 'redis_connection_restored',
    );
    expect(typeof restored?.[0].downForMs).toBe('number');
  });

  it('closes a healthy client quickly and logs redis_closed', async () => {
    const logger = createLogger();
    const { redisClient, close } = await connectReady(logger);

    const startedAt = performance.now();
    await expect(close()).resolves.toBeUndefined();

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    await vi.waitFor(() => {
      expect(logger.info).toHaveBeenCalledWith(...loggedEvent('redis_closed'));
    });
    expect(redisClient.status).toBe('end');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('closes a never-connected client quickly and stops reconnecting', async () => {
    const logger = createLogger();
    const { redisClient, close } = await connectUnreachable(logger);
    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledOnce();
    });
    const attempts = vi.fn();
    redisClient.on('reconnecting', attempts);

    const startedAt = performance.now();
    await expect(close()).resolves.toBeUndefined();
    expect(performance.now() - startedAt).toBeLessThan(1_000);

    await sleep(2_500);
    expect(attempts).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
