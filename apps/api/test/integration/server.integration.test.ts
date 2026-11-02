import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { request, type ClientRequest } from 'node:http';
import { connect, createServer, type AddressInfo } from 'node:net';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const apiRoot = resolve(import.meta.dirname, '../..');
const LISTEN_DEADLINE_MS = 15_000;
const SHORT_SHUTDOWN_TIMEOUT_MS = 5_000;
const STEP_ORDER = ['http_server', 'database', 'redis'];

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is not set; run pnpm test:stack`);
  return value;
};

const findFreePort = async (): Promise<number> => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  probe.close();
  await once(probe, 'close');
  return port;
};

type LogRecord = Record<string, unknown> & { event?: unknown; step?: unknown };

const parseLines = (text: string): LogRecord[] =>
  text
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as LogRecord);

interface ApiProcess {
  readonly child: ChildProcess;
  readonly port: number;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly records: () => LogRecord[];
  readonly exited: Promise<number | null>;
}

const running: ChildProcess[] = [];
const heldRequests: ClientRequest[] = [];

const startApi = async (env: Record<string, string> = {}): Promise<ApiProcess> => {
  const port = await findFreePort();
  let stdout = '';
  let stderr = '';
  const child = spawn(
    process.execPath,
    [
      '--conditions=@starter/source',
      '--import',
      'tsx',
      '--import',
      './test/support/crash-trigger.ts',
      'src/main.ts',
    ],
    {
      cwd: apiRoot,
      env: {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'test',
        LOG_LEVEL: 'info',
        PORT: String(port),
        DATABASE_URL: requireEnv('TEST_DATABASE_URL'),
        REDIS_URL: requireEnv('TEST_REDIS_URL'),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  running.push(child);
  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const exited = new Promise<number | null>((resolveExit) => {
    child.once('exit', (code) => resolveExit(code));
  });

  return {
    child,
    port,
    stdout: () => stdout,
    stderr: () => stderr,
    records: () => parseLines(stdout),
    exited,
  };
};

const canConnect = (port: number): Promise<boolean> =>
  new Promise((resolveConnect) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolveConnect(true);
    });
    socket.once('error', () => resolveConnect(false));
  });

const waitUntilListening = async (api: ApiProcess): Promise<void> => {
  const deadline = Date.now() + LISTEN_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (api.child.exitCode !== null) {
      throw new Error(`API exited with ${String(api.child.exitCode)} before listening`);
    }
    if (await canConnect(api.port)) return;
    await new Promise((wait) => setTimeout(wait, 100));
  }
  throw new Error(`API never listened on port ${String(api.port)}`);
};

const holdRequestOpen = async (port: number): Promise<ClientRequest> => {
  // An incomplete header can still be treated as idle and closed by server.close().
  // Wait for HTTP acknowledgement, then leave the JSON body incomplete instead.
  const held = request({
    hostname: '127.0.0.1',
    port,
    path: '/health/live',
    method: 'POST',
    agent: false,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': '2',
      Expect: '100-continue',
    },
  });
  held.on('error', () => undefined);
  heldRequests.push(held);
  const acknowledged = once(held, 'continue', { signal: AbortSignal.timeout(5_000) });
  held.flushHeaders();
  await acknowledged;
  held.write('{');
  return held;
};

const stepsDone = (api: ApiProcess): unknown[] =>
  api
    .records()
    .filter((record) => record.event === 'step_done')
    .map((record) => record.step);

const eventsNamed = (api: ApiProcess, event: string): LogRecord[] =>
  api.records().filter((record) => record.event === event);

describe('API process lifecycle', () => {
  afterEach(() => {
    for (const request of heldRequests.splice(0)) request.destroy();
    for (const child of running.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'on %s closes the server, then the database, then Redis, and exits 0',
    async (signal) => {
      const api = await startApi();
      await waitUntilListening(api);

      api.child.kill(signal);

      expect(await api.exited).toBe(0);
      expect(stepsDone(api)).toEqual(STEP_ORDER);
      expect(eventsNamed(api, 'step_failed')).toEqual([]);
    },
  );

  it('runs every step once when a second SIGTERM arrives during the drain', async () => {
    const api = await startApi();
    await waitUntilListening(api);
    const held = await holdRequestOpen(api.port);

    api.child.kill('SIGTERM');
    await vi.waitFor(() => {
      expect(eventsNamed(api, 'shutdown_signal_received')).toHaveLength(1);
    });
    api.child.kill('SIGTERM');
    await vi.waitFor(() => {
      expect(eventsNamed(api, 'prevent_duplicate_shutdown')).toHaveLength(1);
    });
    held.destroy();

    expect(await api.exited).toBe(0);
    expect(stepsDone(api)).toEqual(STEP_ORDER);
  });

  it('exits as soon as the steps finish instead of waiting for the deadline', async () => {
    const api = await startApi({ SHUTDOWN_TIMEOUT_MS: '20000' });
    await waitUntilListening(api);
    const startedAt = Date.now();

    api.child.kill('SIGTERM');
    await api.exited;

    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it('stops accepting new connections once shutdown starts', async () => {
    const api = await startApi({
      SHUTDOWN_TIMEOUT_MS: String(SHORT_SHUTDOWN_TIMEOUT_MS),
      DB_STATEMENT_TIMEOUT_MS: '500',
      DB_READINESS_TIMEOUT_MS: '500',
    });
    await waitUntilListening(api);
    await holdRequestOpen(api.port);

    api.child.kill('SIGTERM');
    await vi.waitFor(async () => {
      expect(await canConnect(api.port)).toBe(false);
    });
  });

  it('force-exits with code 1 at the deadline when a request never finishes', async () => {
    const api = await startApi({
      SHUTDOWN_TIMEOUT_MS: String(SHORT_SHUTDOWN_TIMEOUT_MS),
      DB_STATEMENT_TIMEOUT_MS: '500',
      DB_READINESS_TIMEOUT_MS: '500',
    });
    await waitUntilListening(api);
    await holdRequestOpen(api.port);
    const startedAt = Date.now();

    api.child.kill('SIGTERM');
    const code = await api.exited;
    const elapsed = Date.now() - startedAt;

    expect(code).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(SHORT_SHUTDOWN_TIMEOUT_MS - 100);
    expect(elapsed).toBeLessThan(SHORT_SHUTDOWN_TIMEOUT_MS + 3_000);
    expect(eventsNamed(api, 'shutdown_deadline_exceeded')).toHaveLength(1);
  });

  it.each(['uncaught_exception', 'unhandled_rejection'] as const)(
    'on %s logs one fatal line, still runs every step, and exits 1',
    async (mode) => {
      const api = await startApi({ TEST_CRASH_MODE: mode });
      await waitUntilListening(api);

      api.child.kill('SIGUSR2');

      expect(await api.exited).toBe(1);
      expect(eventsNamed(api, mode)).toEqual([expect.objectContaining({ severity: 'FATAL' })]);
      expect(stepsDone(api)).toEqual(STEP_ORDER);
    },
  );

  it('keeps exit code 1 when a crash arrives during a SIGTERM shutdown', async () => {
    const api = await startApi({
      TEST_CRASH_MODE: 'uncaught_exception',
      SHUTDOWN_TIMEOUT_MS: '20000',
    });
    await waitUntilListening(api);
    const held = await holdRequestOpen(api.port);

    api.child.kill('SIGTERM');
    await vi.waitFor(() => {
      expect(eventsNamed(api, 'shutdown_signal_received')).toHaveLength(1);
    });
    api.child.kill('SIGUSR2');
    await vi.waitFor(() => {
      expect(eventsNamed(api, 'uncaught_exception')).toHaveLength(1);
    });
    held.destroy();

    expect(await api.exited).toBe(1);
    expect(stepsDone(api)).toEqual(STEP_ORDER);
    expect(eventsNamed(api, 'shutdown_deadline_exceeded')).toEqual([]);
  });

  it('refuses to start on invalid config, naming the field but never its value', async () => {
    const api = await startApi({ REDIS_URL: 'redis://default:not-a-real-secret@127.0.0.1:1/5' });

    expect(await api.exited).toBe(1);
    expect(api.stderr()).toContain('"event":"config_invalid"');
    expect(api.stderr()).toContain('REDIS_URL');
    expect(api.stderr() + api.stdout()).not.toContain('not-a-real-secret');
    expect(await canConnect(api.port)).toBe(false);
  });

  it('never writes the database or Redis password to the logs', async () => {
    const passwords = [requireEnv('TEST_DATABASE_URL'), requireEnv('TEST_REDIS_URL')].map((url) =>
      decodeURIComponent(new URL(url).password),
    );
    const api = await startApi();
    await waitUntilListening(api);

    api.child.kill('SIGTERM');
    await api.exited;

    for (const password of passwords) {
      expect(api.stdout() + api.stderr()).not.toContain(password);
    }
  });
});
