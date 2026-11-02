import {
  applyLoggerRules,
  databaseEnvSchema,
  environmentEnvSchema,
  integerEnv,
  loggerEnvSchema,
  redisEnvSchema,
  type EnvironmentSource,
} from '@starter/config';
import { QUERY_TIMEOUT_MARGIN_MS } from '@starter/database';
import { QUIT_TIMEOUT_MS } from '@starter/redis';
import * as z from 'zod';

export const SHUTDOWN_MARGIN_MS = QUERY_TIMEOUT_MARGIN_MS + QUIT_TIMEOUT_MS;

const serverEnvSchema = z.object({
  PORT: integerEnv('PORT', { min: 1, max: 65_535, fallback: 8000 }),
  HTTP_REQUEST_TIMEOUT_MS: integerEnv('HTTP_REQUEST_TIMEOUT_MS', {
    min: 1_000,
    max: 300_000,
    fallback: 30_000,
    unit: 'milliseconds',
  }),
  HTTP_HEADERS_TIMEOUT_MS: integerEnv('HTTP_HEADERS_TIMEOUT_MS', {
    min: 1_000,
    max: 120_000,
    fallback: 20_000,
    unit: 'milliseconds',
  }),
  HTTP_KEEP_ALIVE_TIMEOUT_MS: integerEnv('HTTP_KEEP_ALIVE_TIMEOUT_MS', {
    min: 1_000,
    max: 120_000,
    fallback: 5_000,
    unit: 'milliseconds',
  }),
  SHUTDOWN_TIMEOUT_MS: integerEnv('SHUTDOWN_TIMEOUT_MS', {
    min: 5_000,
    max: 120_000,
    fallback: 20_000,
    unit: 'milliseconds',
  }),
});

export const apiEnvSchema = z
  .object({
    ...environmentEnvSchema.shape,
    ...loggerEnvSchema.shape,
    ...serverEnvSchema.shape,
    ...databaseEnvSchema.shape,
    ...redisEnvSchema.shape,
  })
  .superRefine((env, context) => {
    applyLoggerRules(env, context);

    if (env.HTTP_HEADERS_TIMEOUT_MS > env.HTTP_REQUEST_TIMEOUT_MS) {
      context.addIssue({
        code: 'custom',
        path: ['HTTP_HEADERS_TIMEOUT_MS'],
        message: 'Header timeout must not exceed request timeout',
      });
    }

    if (env.DB_READINESS_TIMEOUT_MS > env.DB_STATEMENT_TIMEOUT_MS) {
      context.addIssue({
        code: 'custom',
        path: ['DB_READINESS_TIMEOUT_MS'],
        message: 'Database readiness timeout must not exceed statement timeout',
      });
    }

    // A request's last query, its query_timeout margin and the Redis quit run in sequence.
    if (env.SHUTDOWN_TIMEOUT_MS <= env.DB_STATEMENT_TIMEOUT_MS + SHUTDOWN_MARGIN_MS) {
      context.addIssue({
        code: 'custom',
        path: ['SHUTDOWN_TIMEOUT_MS'],
        message: `Shutdown timeout must exceed database statement timeout plus ${String(SHUTDOWN_MARGIN_MS)} ms`,
      });
    }
  })
  .transform((env) =>
    Object.freeze({
      environment: env.NODE_ENV,
      logging: Object.freeze({ level: env.LOG_LEVEL, pretty: env.LOG_PRETTY }),
      server: Object.freeze({
        port: env.PORT,
        requestTimeoutMs: env.HTTP_REQUEST_TIMEOUT_MS,
        headersTimeoutMs: env.HTTP_HEADERS_TIMEOUT_MS,
        keepAliveTimeoutMs: env.HTTP_KEEP_ALIVE_TIMEOUT_MS,
        shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
      }),
      database: Object.freeze({
        url: env.DATABASE_URL,
        poolMax: env.DB_POOL_MAX,
        connectionTimeoutMs: env.DB_CONNECTION_TIMEOUT_MS,
        idleTimeoutMs: env.DB_POOL_IDLE_TIMEOUT_MS,
        statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
        readinessTimeoutMs: env.DB_READINESS_TIMEOUT_MS,
      }),
      redis: Object.freeze({
        url: env.REDIS_URL,
        commandTimeoutMs: env.REDIS_COMMAND_TIMEOUT_MS,
        connectTimeoutMs: env.REDIS_CONNECT_TIMEOUT_MS,
      }),
    }),
  );

export type ApiConfig = z.output<typeof apiEnvSchema>;

export const parseConfig = (env: EnvironmentSource): ApiConfig => apiEnvSchema.parse(env);

export const loadConfig = (): ApiConfig => parseConfig(process.env);
