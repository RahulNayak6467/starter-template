import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  checkDatabaseHealth,
  closeDatabase,
  createPool,
  type DatabaseLogger,
  type DatabaseOptions,
} from '../../src/index.js';
import {
  assertSafeTestDatabase,
  createAdminPool,
  requireTestDatabaseUrl,
} from '../support/test-database.js';

const APPLICATION_NAME = 'integration-pool-under-test';

const createLogger = () =>
  ({
    debug: vi.fn<DatabaseLogger['debug']>(),
    info: vi.fn<DatabaseLogger['info']>(),
    error: vi.fn<DatabaseLogger['error']>(),
  }) satisfies DatabaseLogger;

const elapsedMs = async (operation: () => Promise<unknown>): Promise<number> => {
  const started = performance.now();
  await operation().catch(() => undefined);
  return performance.now() - started;
};

describe('real PostgreSQL pool', () => {
  let databaseUrl: string;
  let adminPool: Pool | undefined;
  const openPools: Pool[] = [];

  const requireAdminPool = (): Pool => {
    if (adminPool === undefined) {
      throw new Error('Admin pool was not created');
    }

    return adminPool;
  };

  const poolUnderTest = (overrides: Partial<DatabaseOptions> = {}, logger = createLogger()) => {
    const pool = createPool(
      {
        url: databaseUrl,
        poolMax: 2,
        connectionTimeoutMs: 2_000,
        idleTimeoutMs: 30_000,
        statementTimeoutMs: 1_000,
        applicationName: APPLICATION_NAME,
        ...overrides,
      },
      logger,
    );
    openPools.push(pool);
    return pool;
  };

  beforeAll(async () => {
    databaseUrl = requireTestDatabaseUrl();
    adminPool = createAdminPool(databaseUrl);
    await assertSafeTestDatabase(adminPool, databaseUrl);
  });

  afterEach(async () => {
    const pools = openPools.splice(0);
    await Promise.all(pools.filter((pool) => !pool.ended).map((pool) => pool.end()));
  });

  afterAll(async () => {
    await adminPool?.end();
  });

  describe('health', () => {
    it('resolves against the test database', async () => {
      await expect(checkDatabaseHealth(poolUnderTest())).resolves.toBeUndefined();
    });

    it('rejects quickly when PostgreSQL refuses connections', async () => {
      const unreachable = new URL(databaseUrl);
      unreachable.port = '1';
      const pool = poolUnderTest({ url: unreachable.toString(), connectionTimeoutMs: 1_000 });

      await expect(checkDatabaseHealth(pool)).rejects.toThrow();
      expect(await elapsedMs(() => checkDatabaseHealth(pool))).toBeLessThan(1_500);
    });
  });

  describe('timeouts', () => {
    it('identifies its connections with the configured application name', async () => {
      const result = await poolUnderTest().query<{ name: string }>(
        "SELECT current_setting('application_name') AS name",
      );

      expect(result.rows[0]?.name).toBe(APPLICATION_NAME);
    });

    it('lets PostgreSQL cancel a runaway query at the statement timeout', async () => {
      await expect(poolUnderTest().query('SELECT pg_sleep(5)')).rejects.toMatchObject({
        code: '57014',
      });
    });

    it('fails a caller fast when every connection is busy', async () => {
      const pool = poolUnderTest({
        poolMax: 1,
        connectionTimeoutMs: 500,
        statementTimeoutMs: 5_000,
      });
      const busy = pool.query('SELECT pg_sleep(1.5)');

      const started = performance.now();
      await expect(pool.query('SELECT 1')).rejects.toThrow(/timeout/iu);
      expect(performance.now() - started).toBeLessThan(1_200);

      await busy;
    });
  });

  describe('recovery', () => {
    it('logs and keeps serving after the server kills an idle connection', async () => {
      const logger = createLogger();
      const pool = poolUnderTest({}, logger);
      await pool.query('SELECT 1');
      expect(pool.idleCount).toBe(1);

      await requireAdminPool().query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE application_name = $1 AND pid <> pg_backend_pid()`,
        [APPLICATION_NAME],
      );

      await vi.waitFor(() => {
        expect(logger.error).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'postgres_idle_client_error' }),
          expect.any(String),
        );
      });
      await expect(checkDatabaseHealth(pool)).resolves.toBeUndefined();
    });
  });

  describe('closeDatabase', () => {
    it('closes every server session the pool opened', async () => {
      const pool = poolUnderTest();
      await Promise.all([pool.query('SELECT 1'), pool.query('SELECT 1')]);

      await closeDatabase(pool);

      await vi.waitFor(async () => {
        const result = await requireAdminPool().query<{ count: string }>(
          'SELECT count(*) AS count FROM pg_stat_activity WHERE application_name = $1',
          [APPLICATION_NAME],
        );
        expect(result.rows[0]?.count).toBe('0');
      });
    });

    it('lets an in-flight query finish, then refuses new queries', async () => {
      const pool = poolUnderTest({ statementTimeoutMs: 5_000 });
      const inFlight = pool.query<{ done: number }>('SELECT pg_sleep(0.5), 1 AS done');

      const closing = closeDatabase(pool);

      await expect(inFlight).resolves.toMatchObject({ rows: [{ done: 1 }] });
      await closing;
      await expect(pool.query('SELECT 1')).rejects.toThrow();
    });
  });
});
