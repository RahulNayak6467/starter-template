import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRedisClient, type RedisConfig, type RedisLogger } from './redis.js';

const redisDoubles = vi.hoisted(() => ({
  construct: vi.fn<(url: unknown, options: unknown) => void>(),
  quit: vi.fn<() => Promise<'OK'>>(),
  disconnect: vi.fn<() => void>(),
}));

vi.mock('ioredis', async () => {
  const { EventEmitter } = await import('node:events');

  class RedisDouble extends EventEmitter {
    status = 'connecting';
    readonly quit = (): Promise<'OK'> => redisDoubles.quit();
    readonly disconnect = (): void => {
      redisDoubles.disconnect();
    };

    constructor(url: unknown, options: unknown) {
      super();
      redisDoubles.construct(url, options);
    }

    // Like ioredis, status changes before the matching event is emitted.
    override emit(event: string | symbol, ...args: unknown[]): boolean {
      if (event === 'ready') this.status = 'ready';
      if (event === 'close') this.status = 'reconnecting';
      if (event === 'end') this.status = 'end';
      return super.emit(event, ...args);
    }
  }

  return { Redis: RedisDouble };
});

const SECRET_PASSWORD = ['redis', 'unit', 'pass'].join('-');

const options: RedisConfig = {
  url: `redis://:${SECRET_PASSWORD}@127.0.0.1:6379`,
  commandTimeoutMs: 150,
  connectTimeoutMs: 3_000,
};

const createLogger = () =>
  ({
    debug: vi.fn<RedisLogger['debug']>(),
    info: vi.fn<RedisLogger['info']>(),
    warn: vi.fn<RedisLogger['warn']>(),
    error: vi.fn<RedisLogger['error']>(),
  }) satisfies RedisLogger;

const createReadyClient = (logger = createLogger()) => {
  const connection = createRedisClient(options, logger);
  connection.redisClient.emit('ready');
  return connection;
};

const connectionRefused = (): Error =>
  Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), {
    code: 'ECONNREFUSED',
    syscall: 'connect',
    address: '127.0.0.1',
    port: 6379,
  });

const neverSettles = (): Promise<'OK'> => new Promise<'OK'>(() => undefined);

const requireConstructorOptions = (): Record<string, unknown> => {
  const constructorOptions: unknown = redisDoubles.construct.mock.calls[0]?.[1];

  if (typeof constructorOptions !== 'object' || constructorOptions === null) {
    throw new Error('Expected the Redis client to be constructed with an options object');
  }

  return { ...constructorOptions };
};

const requireRetryStrategy = (): ((times: number) => unknown) => {
  const retryStrategy = requireConstructorOptions().retryStrategy;

  if (typeof retryStrategy !== 'function') {
    throw new Error('Expected a retryStrategy function');
  }

  return (times: number): unknown => Reflect.apply(retryStrategy, undefined, [times]);
};

describe('createRedisClient', () => {
  beforeEach(() => {
    redisDoubles.construct.mockReset();
    redisDoubles.quit.mockReset();
    redisDoubles.quit.mockResolvedValue('OK');
    redisDoubles.disconnect.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('client options', () => {
    it('fails fast: no offline queue, the configured timeouts, one retry per command', () => {
      createRedisClient(
        { ...options, commandTimeoutMs: 120, connectTimeoutMs: 1_500 },
        createLogger(),
      );

      expect(redisDoubles.construct).toHaveBeenCalledOnce();
      expect(redisDoubles.construct).toHaveBeenCalledWith(
        options.url,
        expect.objectContaining({
          enableOfflineQueue: false,
          commandTimeout: 120,
          connectTimeout: 1_500,
          maxRetriesPerRequest: 1,
        }),
      );
    });

    it('keeps reconnecting forever, never waiting longer than 2000 ms', () => {
      createRedisClient(options, createLogger());
      const retryStrategy = requireRetryStrategy();

      for (const times of [1, 2, 3, 5, 10, 50, 100, 1_000, 100_000]) {
        const delay = retryStrategy(times);

        expect(typeof delay).toBe('number');
        expect(delay).toBeGreaterThan(0);
        expect(delay).toBeLessThanOrEqual(2_000);
      }
    });

    it('grows the delay with each attempt and jitters it within the upper half', () => {
      createRedisClient(options, createLogger());
      const retryStrategy = requireRetryStrategy();
      const random = vi.spyOn(Math, 'random');

      random.mockReturnValue(0);
      expect([1, 2, 3, 20].map(retryStrategy)).toEqual([50, 100, 200, 1_000]);
      random.mockReturnValue(0.999_999);
      expect(retryStrategy(20)).toBe(2_000);
      random.mockReturnValue(0.5);
      expect(retryStrategy(20)).toBe(1_500);
    });

    it('always listens for errors so ioredis never reports an unhandled error', () => {
      const { redisClient } = createRedisClient(options, createLogger());

      expect(redisClient.listenerCount('error')).toBeGreaterThanOrEqual(1);
    });
  });

  describe('lifecycle logging', () => {
    it('logs redis_connected when the first connection becomes ready', () => {
      const logger = createLogger();
      const { redisClient } = createRedisClient(options, logger);

      redisClient.emit('ready');

      expect(logger.info).toHaveBeenCalledExactlyOnceWith(
        { component: 'redis', event: 'redis_connected' },
        expect.any(String),
      );
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('warns once with safe fields when Redis is unavailable at startup', () => {
      const logger = createLogger();
      const { redisClient } = createRedisClient(options, logger);

      redisClient.emit('error', connectionRefused());
      redisClient.emit('error', connectionRefused());
      redisClient.emit('error', connectionRefused());

      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        {
          component: 'redis',
          event: 'redis_unavailable_at_startup',
          errorDetails: {
            type: 'Error',
            message: 'connect ECONNREFUSED 127.0.0.1:6379',
            code: 'ECONNREFUSED',
            syscall: 'connect',
            address: '127.0.0.1',
            port: 6379,
          },
        },
        expect.any(String),
      );
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    });

    it('logs redis_connected when a never-connected client finally becomes ready', () => {
      const logger = createLogger();
      const { redisClient } = createRedisClient(options, logger);
      redisClient.emit('error', connectionRefused());

      redisClient.emit('ready');

      expect(logger.info).toHaveBeenCalledExactlyOnceWith(
        { component: 'redis', event: 'redis_connected' },
        expect.any(String),
      );
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('logs one redis_connection_lost for an outage, however many errors follow', () => {
      const logger = createLogger();
      const { redisClient } = createReadyClient(logger);

      for (let attempt = 0; attempt < 10; attempt += 1) {
        redisClient.emit('error', connectionRefused());
      }

      expect(logger.error).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ component: 'redis', event: 'redis_connection_lost' }),
        expect.any(String),
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('logs redis_connection_restored with downForMs on the monotonic clock', () => {
      const logger = createLogger();
      const monotonicMs = vi.fn<() => number>();
      const { redisClient } = createRedisClient(options, logger, { monotonicMs });
      redisClient.emit('ready');
      logger.info.mockClear();
      monotonicMs.mockReturnValue(10_000);
      redisClient.emit('error', connectionRefused());
      redisClient.emit('error', connectionRefused());
      monotonicMs.mockReturnValue(13_500);

      redisClient.emit('ready');

      expect(logger.info).toHaveBeenCalledExactlyOnceWith(
        { component: 'redis', event: 'redis_connection_restored', downForMs: 3_500 },
        expect.any(String),
      );
    });

    it('measures each outage separately across repeated lose and restore cycles', () => {
      const logger = createLogger();
      const monotonicMs = vi.fn<() => number>();
      const { redisClient } = createRedisClient(options, logger, { monotonicMs });
      redisClient.emit('ready');
      logger.info.mockClear();

      monotonicMs.mockReturnValue(1_000);
      redisClient.emit('error', connectionRefused());
      monotonicMs.mockReturnValue(1_200);
      redisClient.emit('ready');
      monotonicMs.mockReturnValue(5_000);
      redisClient.emit('error', connectionRefused());
      monotonicMs.mockReturnValue(9_000);
      redisClient.emit('ready');

      expect(logger.error).toHaveBeenCalledTimes(2);
      expect(logger.info.mock.calls.map(([fields]) => fields)).toEqual([
        { component: 'redis', event: 'redis_connection_restored', downForMs: 200 },
        { component: 'redis', event: 'redis_connection_restored', downForMs: 4_000 },
      ]);
    });

    it('keeps state per client so two clients do not affect each other', () => {
      const firstLogger = createLogger();
      const secondLogger = createLogger();
      const first = createRedisClient(options, firstLogger);
      const second = createRedisClient(options, secondLogger);

      first.redisClient.emit('ready');
      second.redisClient.emit('error', connectionRefused());

      expect(firstLogger.info).toHaveBeenCalledOnce();
      expect(firstLogger.warn).not.toHaveBeenCalled();
      expect(secondLogger.warn).toHaveBeenCalledOnce();
      expect(secondLogger.info).not.toHaveBeenCalled();
    });
  });

  describe('connection closed without an error', () => {
    it('logs redis_connection_lost once when a connected client closes', () => {
      const logger = createLogger();
      const { redisClient } = createReadyClient(logger);

      redisClient.emit('close');
      redisClient.emit('error', connectionRefused());
      redisClient.emit('close');

      expect(logger.error).toHaveBeenCalledExactlyOnceWith(
        { component: 'redis', event: 'redis_connection_lost' },
        expect.any(String),
      );
    });

    it('measures downForMs from the close', () => {
      const logger = createLogger();
      const monotonicMs = vi.fn<() => number>();
      const { redisClient } = createRedisClient(options, logger, { monotonicMs });
      redisClient.emit('ready');
      logger.info.mockClear();
      monotonicMs.mockReturnValue(20_000);
      redisClient.emit('close');
      monotonicMs.mockReturnValue(22_750);

      redisClient.emit('ready');

      expect(logger.info).toHaveBeenCalledExactlyOnceWith(
        { component: 'redis', event: 'redis_connection_restored', downForMs: 2_750 },
        expect.any(String),
      );
    });

    it('does not log an outage for a close while still connecting', () => {
      const logger = createLogger();
      const { redisClient } = createRedisClient(options, logger);

      redisClient.emit('close');

      expect(logger.error).not.toHaveBeenCalled();
    });

    it('does not log an outage for a close after a failed startup', () => {
      const logger = createLogger();
      const { redisClient } = createRedisClient(options, logger);
      redisClient.emit('error', connectionRefused());

      redisClient.emit('close');

      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledOnce();
    });

    it('does not log the outage again for a close while already disconnected', () => {
      const logger = createLogger();
      const { redisClient } = createReadyClient(logger);
      redisClient.emit('error', connectionRefused());

      redisClient.emit('close');

      expect(logger.error).toHaveBeenCalledOnce();
    });
  });

  describe('error field allowlist', () => {
    const errorWithSecrets = (): Error =>
      Object.assign(new Error('NOAUTH Authentication required'), {
        name: 'ReplyError',
        code: 'NOAUTH',
        command: { name: 'auth', args: [SECRET_PASSWORD] },
        previousErrors: [new Error(`AUTH ${SECRET_PASSWORD}`)],
        options: { password: SECRET_PASSWORD },
      });

    it('logs only the allowlisted fields and the command name', () => {
      const logger = createLogger();
      const { redisClient } = createReadyClient(logger);

      redisClient.emit('error', errorWithSecrets());

      expect(logger.error).toHaveBeenCalledExactlyOnceWith(
        {
          component: 'redis',
          event: 'redis_connection_lost',
          errorDetails: {
            type: 'ReplyError',
            message: 'NOAUTH Authentication required',
            code: 'NOAUTH',
            command: 'auth',
          },
        },
        expect.any(String),
      );
    });

    it('never logs command arguments, the stack or the raw error on any path', () => {
      const logger = createLogger();
      const { redisClient } = createRedisClient(options, logger);
      const startupError = errorWithSecrets();
      const lostError = errorWithSecrets();

      redisClient.emit('error', startupError);
      redisClient.emit('ready');
      redisClient.emit('error', lostError);

      const allCalls = [
        ...logger.debug.mock.calls,
        ...logger.info.mock.calls,
        ...logger.warn.mock.calls,
        ...logger.error.mock.calls,
      ];
      const serialized = JSON.stringify(allCalls);
      expect(serialized).not.toContain(SECRET_PASSWORD);
      expect(serialized).not.toContain('args');
      expect(serialized).not.toContain('stack');
      const loggedErrors = allCalls.map(([fields]) => fields.errorDetails);
      expect(loggedErrors).not.toContain(startupError);
      expect(loggedErrors).not.toContain(lostError);
    });

    it('drops allowlisted fields that are not strings or numbers', () => {
      const logger = createLogger();
      const { redisClient } = createRedisClient(options, logger);
      const error = Object.assign(new Error('weird'), {
        code: { nested: SECRET_PASSWORD },
        command: { name: 42, args: [SECRET_PASSWORD] },
      });

      redisClient.emit('error', error);

      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        {
          component: 'redis',
          event: 'redis_unavailable_at_startup',
          errorDetails: { type: 'Error', message: 'weird' },
        },
        expect.any(String),
      );
    });
  });

  describe('close', () => {
    it('quits gracefully without forcing a disconnect, leaving no timers', async () => {
      vi.useFakeTimers();
      const { close } = createReadyClient();

      await expect(close()).resolves.toBeUndefined();

      expect(redisDoubles.quit).toHaveBeenCalledOnce();
      expect(redisDoubles.disconnect).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('forces a disconnect at 2 s when quit never settles, leaving no timers', async () => {
      vi.useFakeTimers();
      const logger = createLogger();
      const { close } = createReadyClient(logger);
      redisDoubles.quit.mockReturnValue(neverSettles());
      let settled = false;

      const closing = close().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(1_999);

      expect(redisDoubles.disconnect).not.toHaveBeenCalled();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await closing;

      expect(redisDoubles.disconnect).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'redis_quit_timed_out' }),
        expect.any(String),
      );
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
      ['rejects', () => Promise.reject(new Error('Connection is closed.'))],
      [
        'throws synchronously',
        () => {
          throw new Error('Connection is closed.');
        },
      ],
    ])('disconnects and resolves when quit %s, leaving no timers', async (_label, quit) => {
      vi.useFakeTimers();
      const { close } = createReadyClient();
      redisDoubles.quit.mockImplementation(quit);

      await expect(close()).resolves.toBeUndefined();

      expect(redisDoubles.disconnect).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
      ['rejects', () => Promise.reject(new Error('Connection is closed.'))],
      ['never settles', neverSettles],
    ])('still resolves when quit %s and the fallback disconnect throws', async (_label, quit) => {
      vi.useFakeTimers();
      const { close } = createReadyClient();
      redisDoubles.quit.mockImplementation(quit);
      redisDoubles.disconnect.mockImplementation(() => {
        throw new Error('disconnect failed');
      });

      const outcome = close().then(
        () => 'resolved',
        () => 'rejected',
      );
      await vi.advanceTimersByTimeAsync(2_500);

      await expect(outcome).resolves.toBe('resolved');
      expect(redisDoubles.disconnect).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('warns once with safe fields when quit fails', async () => {
      const logger = createLogger();
      const { close } = createReadyClient(logger);
      redisDoubles.quit.mockRejectedValue(
        Object.assign(new Error('Connection is closed.'), {
          command: { name: 'quit', args: [SECRET_PASSWORD] },
        }),
      );

      await close();

      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        {
          component: 'redis',
          event: 'redis_quit_failed',
          errorDetails: { type: 'Error', message: 'Connection is closed.', command: 'quit' },
        },
        expect.any(String),
      );
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(SECRET_PASSWORD);
    });

    it('returns the same pending close to a second caller and quits only once', async () => {
      const { close } = createReadyClient();
      let finishQuit: (value: 'OK') => void = () => undefined;
      redisDoubles.quit.mockReturnValue(
        new Promise<'OK'>((resolve) => {
          finishQuit = resolve;
        }),
      );
      let secondSettled = false;

      const first = close();
      const second = close().then(() => {
        secondSettled = true;
      });
      await Promise.resolve();

      expect(secondSettled).toBe(false);

      finishQuit('OK');
      await Promise.all([first, second]);

      expect(secondSettled).toBe(true);
      expect(redisDoubles.quit).toHaveBeenCalledOnce();
    });

    it('disconnects a client that is not ready without trying quit or warning', async () => {
      vi.useFakeTimers();
      const logger = createLogger();
      const { redisClient, close } = createRedisClient(options, logger);
      redisClient.emit('error', connectionRefused());
      logger.warn.mockClear();

      await expect(close()).resolves.toBeUndefined();

      expect(redisDoubles.quit).not.toHaveBeenCalled();
      expect(redisDoubles.disconnect).toHaveBeenCalledOnce();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('logs redis_closed when the client ends after close()', async () => {
      const logger = createLogger();
      const { redisClient, close } = createReadyClient(logger);
      logger.info.mockClear();
      await close();

      redisClient.emit('end');

      expect(logger.info).toHaveBeenCalledExactlyOnceWith(
        { component: 'redis', event: 'redis_closed' },
        expect.any(String),
      );
    });

    it('marks the client as closing before quit, so errors during quit are not an outage', async () => {
      const logger = createLogger();
      const { redisClient, close } = createReadyClient(logger);
      redisDoubles.quit.mockImplementation(() => {
        redisClient.emit('error', connectionRefused());
        redisClient.emit('end');
        return Promise.resolve('OK');
      });

      await close();

      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenLastCalledWith(
        { component: 'redis', event: 'redis_closed' },
        expect.any(String),
      );
    });

    it('stays silent on error, close and ready events after close()', async () => {
      const logger = createLogger();
      const { redisClient, close } = createReadyClient(logger);
      logger.info.mockClear();
      await close();

      redisClient.emit('error', connectionRefused());
      redisClient.emit('close');
      redisClient.emit('ready');

      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    });

    it('logs no outage or reconnection after closing a never-connected client', async () => {
      const logger = createLogger();
      const { redisClient, close } = createRedisClient(options, logger);
      redisClient.emit('error', connectionRefused());

      await close();
      redisClient.emit('error', connectionRefused());
      redisClient.emit('ready');

      expect(logger.warn).toHaveBeenCalledOnce();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    });
  });
});
