import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

process.loadEnvFile(new URL('../.env.test', import.meta.url));
const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
let testDatabase;
try {
  testDatabase = new URL(databaseUrl ?? '');
} catch {
  throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL connection URL');
}
if (
  !redisUrl ||
  !['postgres:', 'postgresql:'].includes(testDatabase.protocol) ||
  !/^[A-Za-z0-9_]+_test$/u.test(decodeURIComponent(testDatabase.pathname.slice(1)))
) {
  throw new Error('Smoke tests require TEST_DATABASE_URL ending in _test and TEST_REDIS_URL');
}

const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const address = probe.address();
assert(address && typeof address !== 'string');
const port = address.port;
await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));

const child = spawn(process.execPath, ['--enable-source-maps', 'apps/api/dist/main.js'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: {
    ...process.env,
    NODE_OPTIONS: '',
    NODE_ENV: 'production',
    LOG_LEVEL: 'info',
    LOG_PRETTY: 'false',
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let logs = '';
child.stdout.on('data', (chunk) => {
  logs += String(chunk);
});
child.stderr.on('data', (chunk) => {
  logs += String(chunk);
});
const exited = once(child, 'exit');
// A failed smoke test must never leave a process running in CI or a developer shell.
const killTimer = setTimeout(() => child.kill('SIGKILL'), 30_000);

try {
  const deadline = Date.now() + 15_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Built API exited before readiness.\n${logs}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        assert.deepEqual(await response.json(), { status: 'ready' });
        assert(response.headers.get('x-request-id'));
        ready = true;
        break;
      }
    } catch {
      // Connection refusal is expected while the process starts.
    }
    await sleep(100);
  }
  assert(ready, `Built API never became ready.\n${logs}`);
  const live = await fetch(`http://127.0.0.1:${port}/health/live`, {
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: 'ok' });

  child.kill('SIGTERM');
  const [code, signal] = await exited;
  assert.equal(signal, null, logs);
  assert.equal(code, 0, logs);
  console.info('Built API passed liveness, PostgreSQL/Redis readiness, and graceful shutdown.');
} finally {
  clearTimeout(killTimer);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}
