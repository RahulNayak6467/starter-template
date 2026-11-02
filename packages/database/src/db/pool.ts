import { Pool, type PoolConfig } from 'pg';

export interface DatabaseLogger {
  debug(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface DatabaseOptions {
  readonly url: string;
  readonly poolMax: number;
  readonly connectionTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly statementTimeoutMs: number;
  // Identifies the process in pg_stat_activity.
  readonly applicationName: string;
}

const KEEP_ALIVE_INITIAL_DELAY_MS = 10_000;
export const QUERY_TIMEOUT_MARGIN_MS = 2_000;

export const createPool = (options: DatabaseOptions, logger: DatabaseLogger) => {
  const pool = new Pool({
    connectionString: options.url,
    max: options.poolMax,
    connectionTimeoutMillis: options.connectionTimeoutMs,
    idleTimeoutMillis: options.idleTimeoutMs,
    statement_timeout: options.statementTimeoutMs,
    query_timeout: options.statementTimeoutMs + QUERY_TIMEOUT_MARGIN_MS,
    application_name: options.applicationName,
    keepAlive: true,
    keepAliveInitialDelayMillis: KEEP_ALIVE_INITIAL_DELAY_MS,
  } satisfies PoolConfig);

  pool.on('connect', () => {
    logger.debug(
      { component: 'postgres', event: 'postgres_connection_opened' },
      'PostgreSQL pool opened a connection',
    );
  });

  pool.on('error', (error) => {
    logger.error(
      {
        component: 'postgres',
        event: 'postgres_idle_client_error',
        errorDetails: {
          name: error.name,
          message: error.message,
          stack: error.stack,
          ...('code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
        },
        totalConnections: pool.totalCount,
        idleConnections: pool.idleCount,
        waitingRequests: pool.waitingCount,
      },
      'PostgreSQL idle client emitted an error',
    );
  });
  logger.info(
    {
      component: 'postgres',
      event: 'postgres_pool_configured',
      applicationName: options.applicationName,
      maxConnections: options.poolMax,
      connectionTimeoutMs: options.connectionTimeoutMs,
      idleTimeoutMs: options.idleTimeoutMs,
      statementTimeoutMs: options.statementTimeoutMs,
    },
    'PostgreSQL pool configured',
  );

  return pool;
};

export const checkDatabaseHealth = async (db: Pick<Pool, 'query'>): Promise<void> => {
  await db.query('SELECT 1 AS result');
};

export const closeDatabase = async (db: Pool): Promise<void> => {
  await db.end();
};
