import { systemClock, type Clock } from '@starter/shared';
import { Redis } from 'ioredis';

export interface RedisLogger {
  debug(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

const SAFE_ERROR_FIELDS = ['code', 'syscall', 'address', 'port'] as const;

const toSafeErrorFields = (error: Error): Record<string, unknown> => {
  const fields: Record<string, unknown> = { type: error.name, message: error.message };

  for (const field of SAFE_ERROR_FIELDS) {
    const value: unknown = Reflect.get(error, field);
    if (typeof value === 'string' || typeof value === 'number') fields[field] = value;
  }

  const command: unknown = Reflect.get(error, 'command');
  if (typeof command === 'object' && command !== null && 'name' in command) {
    if (typeof command.name === 'string') fields.command = command.name;
  }

  return fields;
};

type ConnectionState = 'connecting' | 'connected' | 'closing' | 'never_connected' | 'disconnected';

export interface RedisConfig {
  readonly url: string;
  readonly commandTimeoutMs: number;
  readonly connectTimeoutMs: number;
}

const MAX_RETRIES_PER_REQUEST = 1;
const ENABLE_OFFLINE_QUEUE = false;
const MAX_RECONNECT_DELAY_MS = 2000;
export const QUIT_TIMEOUT_MS = 2000;
const QUIT_TIMED_OUT = Symbol('quit timed out');
const BASE_RECONNECT_DELAY_MS = 50;

const reconnectDelayMs = (attempt: number): number => {
  const ceiling = Math.min(
    MAX_RECONNECT_DELAY_MS,
    BASE_RECONNECT_DELAY_MS * 2 ** Math.min(attempt, 16),
  );
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
};

export const createRedisClient = (
  options: RedisConfig,
  logger: RedisLogger,
  clock: Pick<Clock, 'monotonicMs'> = systemClock,
): {
  redisClient: Redis;
  close: () => Promise<void>;
} => {
  const forcedDisconnect = () => {
    try {
      redisClient.disconnect();
    } catch (err: unknown) {
      if (err instanceof Error) {
        logger.warn(
          {
            component: 'redis',
            event: 'redis_disconnect_failed',
            errorDetails: toSafeErrorFields(err),
          },
          'Redis disconnection failed',
        );
      } else {
        logger.warn(
          {
            component: 'redis',
            event: 'redis_disconnect_failed',
            thrown: typeof err,
          },
          'Redis disconnection failed',
        );
      }
    }
  };

  let connectionState: ConnectionState = 'connecting';

  let closePromise: Promise<void> | undefined;

  const close = (): Promise<void> => {
    closePromise ??= closeOnce();
    return closePromise;
  };

  const closeOnce = async (): Promise<void> => {
    connectionState = 'closing';

    if (redisClient.status !== 'ready') {
      forcedDisconnect();
      return;
    }

    let timer: undefined | NodeJS.Timeout;
    const timeout = new Promise<typeof QUIT_TIMED_OUT>(
      (resolve) => (timer = setTimeout(() => resolve(QUIT_TIMED_OUT), QUIT_TIMEOUT_MS)),
    );

    try {
      const result = await Promise.race([redisClient.quit(), timeout]);
      if (result === QUIT_TIMED_OUT) {
        logger.warn(
          { component: 'redis', event: 'redis_quit_timed_out' },
          'Redis quit timed out; forcing disconnect',
        );
        forcedDisconnect();
      }
    } catch (error: unknown) {
      logger.warn(
        {
          component: 'redis',
          event: 'redis_quit_failed',
          ...(error instanceof Error
            ? { errorDetails: toSafeErrorFields(error) }
            : { thrown: typeof error }),
        },
        'Redis quit failed; forcing disconnect',
      );
      forcedDisconnect();
    } finally {
      clearTimeout(timer);
    }
  };

  const redisClient = new Redis(options.url, {
    enableOfflineQueue: ENABLE_OFFLINE_QUEUE,
    commandTimeout: options.commandTimeoutMs,
    connectTimeout: options.connectTimeoutMs,
    maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,
    retryStrategy: reconnectDelayMs,
  });
  let downSince: number | undefined;

  redisClient.on('ready', () => {
    if (connectionState === 'connecting' || connectionState === 'never_connected') {
      logger.info({ component: 'redis', event: 'redis_connected' }, 'Redis connected');
      connectionState = 'connected';
    }
    if (connectionState === 'disconnected') {
      const downForMs =
        downSince === undefined ? undefined : Math.round(clock.monotonicMs() - downSince);
      logger.info(
        { component: 'redis', event: 'redis_connection_restored', downForMs },
        'Redis connection restored',
      );
      downSince = undefined;
      connectionState = 'connected';
    }
  });

  redisClient.on('error', (error: Error) => {
    if (connectionState === 'connected') {
      logger.error(
        {
          component: 'redis',
          event: 'redis_connection_lost',
          errorDetails: toSafeErrorFields(error),
        },
        'Redis connection lost; retrying connection',
      );
      downSince = clock.monotonicMs();
      connectionState = 'disconnected';
    }
    if (connectionState === 'connecting') {
      logger.warn(
        {
          component: 'redis',
          event: 'redis_unavailable_at_startup',
          errorDetails: toSafeErrorFields(error),
        },
        'Redis unavailable at startup; retrying connection',
      );
      connectionState = 'never_connected';
    }
  });

  redisClient.on('close', () => {
    if (connectionState === 'connected') {
      logger.error(
        { component: 'redis', event: 'redis_connection_lost' },
        'Redis connection closed',
      );
      downSince = clock.monotonicMs();
      connectionState = 'disconnected';
    }
  });

  redisClient.on('end', () => {
    if (connectionState === 'closing') {
      logger.info({ component: 'redis', event: 'redis_closed' }, 'Redis client closed');
    }
  });

  return { redisClient, close };
};
