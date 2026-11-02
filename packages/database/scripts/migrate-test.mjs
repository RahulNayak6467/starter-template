import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (process.env.NODE_ENV !== 'test' || !databaseUrl) {
  throw new Error('Test migrations require NODE_ENV=test and TEST_DATABASE_URL');
}

let url;
try {
  url = new URL(databaseUrl);
} catch {
  throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL connection URL');
}
if (
  !['postgres:', 'postgresql:'].includes(url.protocol) ||
  url.hostname.length === 0 ||
  !/^[A-Za-z0-9_]+_test$/u.test(decodeURIComponent(url.pathname.slice(1)))
) {
  throw new Error('Test migrations require a PostgreSQL database whose name ends with _test');
}

const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(
      new URL('../node_modules/node-pg-migrate/bin/node-pg-migrate.js', import.meta.url),
    ),
    'up',
    '--migrations-dir',
    'migrations',
    '--migrations-table',
    'schema_migrations',
    '--advisory-lock-mode',
    'fail',
    '--single-transaction',
    '--check-order',
    '--no-verbose',
  ],
  {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
