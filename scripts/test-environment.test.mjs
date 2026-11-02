import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const migrationScript = fileURLToPath(
  new URL('../packages/database/scripts/migrate-test.mjs', import.meta.url),
);

for (const [name, environment] of [
  [
    'non-test mode',
    { NODE_ENV: 'production', TEST_DATABASE_URL: 'postgres://localhost/example_test' },
  ],
  ['missing connection URL', { NODE_ENV: 'test', TEST_DATABASE_URL: '' }],
  ['non-test database', { NODE_ENV: 'test', TEST_DATABASE_URL: 'postgres://localhost/example' }],
  ['wrong protocol', { NODE_ENV: 'test', TEST_DATABASE_URL: 'redis://localhost/example_test' }],
  ['missing hostname', { NODE_ENV: 'test', TEST_DATABASE_URL: 'postgres:///example_test' }],
]) {
  test(`test migrations reject ${name} before running the migration tool`, () => {
    const result = spawnSync(process.execPath, [migrationScript], {
      env: { ...process.env, ...environment },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Test migrations require/);
  });
}

test('a malformed test URL fails without printing its credential-like contents', () => {
  const marker = 'private-value-for-this-test';
  const result = spawnSync(process.execPath, [migrationScript], {
    env: { ...process.env, NODE_ENV: 'test', TEST_DATABASE_URL: `postgres://${marker}:[` },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be a valid PostgreSQL connection URL/);
  assert(!result.stderr.includes(marker));
});
