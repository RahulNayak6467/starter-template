import { Pool } from 'pg';

const TEST_DATABASE_NAME = /^[A-Za-z0-9_]+_test$/u;

const requireEnv = (name: string): string => {
  const value = process.env[name];

  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for integration tests (see .env.test.example)`);
  }

  return value;
};

// TEST_* only: a DATABASE_URL exported in the shell must never reach these tests.
export const requireTestDatabaseUrl = (): string => requireEnv('TEST_DATABASE_URL');

export const createAdminPool = (databaseUrl: string): Pool =>
  new Pool({
    connectionString: databaseUrl,
    application_name: 'integration-admin',
    max: 2,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 1_000,
    statement_timeout: 5_000,
  });

export const assertSafeTestDatabase = async (pool: Pool, databaseUrl: string): Promise<void> => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Database integration tests require NODE_ENV=test');
  }

  const configured = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));

  if (!TEST_DATABASE_NAME.test(configured)) {
    throw new Error('The integration database name must end with _test');
  }

  const result = await pool.query<{ name: string }>('SELECT current_database() AS name');

  if (result.rows[0]?.name !== configured) {
    throw new Error('The connected database does not match TEST_DATABASE_URL');
  }
};
