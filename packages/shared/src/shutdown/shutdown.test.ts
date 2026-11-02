import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

type Listener = (...args: unknown[]) => void;

const listenersOf = (event: string): Listener[] =>
  EventEmitter.prototype.listeners.call(process, event) as Listener[];

const removeListener = (event: string, listener: Listener): void => {
  EventEmitter.prototype.removeListener.call(process, event, listener);
};

const TIMEOUT_MS = 1_000;
const HANDLED_EVENTS = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'] as const;

// The coordinator keeps its state at module level, so every test needs a fresh copy.
const loadShutdown = async () => {
  vi.resetModules();
  return import('./shutdown.js');
};

const createLogger = () => ({ fatal: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() });

const recordingStep = (name: string, calls: string[]) => ({
  name,
  run: () => {
    calls.push(name);
    return Promise.resolve();
  },
});

const deferred = () => {
  let finish = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
};

const loggedEvents = (logger: ReturnType<typeof createLogger>, level: 'info' | 'warn' | 'error') =>
  logger[level].mock.calls.map(([fields]) => (fields as { event: string }).event);

describe('shutdown coordinator', () => {
  let originalExitCode: typeof process.exitCode;
  let exit: MockInstance<typeof process.exit>;

  beforeEach(() => {
    originalExitCode = process.exitCode;
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.useRealTimers();
  });

  it('runs the steps in order, each only after the previous one finished', async () => {
    const { handleShutdown } = await loadShutdown();
    const calls: string[] = [];
    const first = deferred();
    const steps = [
      {
        name: 'first',
        run: () => {
          calls.push('first');
          return first.promise;
        },
      },
      recordingStep('second', calls),
    ];

    const done = handleShutdown('SIGTERM', createLogger(), steps, TIMEOUT_MS);
    await Promise.resolve();
    expect(calls).toEqual(['first']);

    first.finish();
    await done;
    expect(calls).toEqual(['first', 'second']);
  });

  it('logs every finished step by name and leaves the exit code alone', async () => {
    const { handleShutdown } = await loadShutdown();
    const logger = createLogger();
    const calls: string[] = [];

    await handleShutdown(
      'SIGTERM',
      logger,
      [recordingStep('a', calls), recordingStep('b', calls)],
      TIMEOUT_MS,
    );

    expect(logger.info).toHaveBeenCalledWith({ event: 'step_done', step: 'a' }, 'Step done');
    expect(logger.info).toHaveBeenCalledWith({ event: 'step_done', step: 'b' }, 'Step done');
    expect(process.exitCode).toBe(originalExitCode);
  });

  it('still runs later steps when one rejects, names the failed step, and sets exit code 1', async () => {
    const { handleShutdown } = await loadShutdown();
    const logger = createLogger();
    const calls: string[] = [];
    const failure = new Error('pool end failed');
    const steps = [
      { name: 'database', run: () => Promise.reject(failure) },
      recordingStep('redis', calls),
    ];

    await handleShutdown('SIGTERM', logger, steps, TIMEOUT_MS);

    expect(calls).toEqual(['redis']);
    expect(logger.error).toHaveBeenCalledWith(
      { event: 'step_failed', step: 'database', err: failure },
      'Step failed',
    );
    expect(process.exitCode).toBe(1);
  });

  it('treats a step that throws before returning a promise like a failed step', async () => {
    const { handleShutdown } = await loadShutdown();
    const calls: string[] = [];
    const steps = [
      {
        name: 'broken',
        run: (): Promise<void> => {
          throw new Error('thrown synchronously');
        },
      },
      recordingStep('after', calls),
    ];

    await handleShutdown('SIGTERM', createLogger(), steps, TIMEOUT_MS);

    expect(calls).toEqual(['after']);
    expect(process.exitCode).toBe(1);
  });

  it('runs the steps once when a second request arrives while the first is running', async () => {
    const { handleShutdown } = await loadShutdown();
    const logger = createLogger();
    const calls: string[] = [];
    const slow = deferred();
    const steps = [
      {
        name: 'slow',
        run: () => {
          calls.push('slow');
          return slow.promise;
        },
      },
    ];

    const first = handleShutdown('SIGTERM', logger, steps, TIMEOUT_MS);
    await handleShutdown('SIGTERM', logger, steps, TIMEOUT_MS);
    slow.finish();
    await first;

    expect(calls).toEqual(['slow']);
    expect(loggedEvents(logger, 'warn')).toEqual(['prevent_duplicate_shutdown']);
  });

  it('runs nothing when asked again after it has stopped', async () => {
    const { handleShutdown } = await loadShutdown();
    const logger = createLogger();
    const calls: string[] = [];
    const steps = [recordingStep('only', calls)];

    await handleShutdown('SIGTERM', logger, steps, TIMEOUT_MS);
    await handleShutdown('SIGINT', logger, steps, TIMEOUT_MS);

    expect(calls).toEqual(['only']);
    expect(loggedEvents(logger, 'warn')).toEqual(['server_already_shutdown']);
  });

  it('reports draining from the moment shutdown starts, before any step finishes', async () => {
    const { handleShutdown, isDraining } = await loadShutdown();
    const slow = deferred();

    expect(isDraining()).toBe(false);
    const done = handleShutdown(
      'SIGTERM',
      createLogger(),
      [{ name: 'slow', run: () => slow.promise }],
      TIMEOUT_MS,
    );
    expect(isDraining()).toBe(true);

    slow.finish();
    await done;
    expect(isDraining()).toBe(true);
  });

  it('force-exits with code 1 at the deadline when a step hangs', async () => {
    vi.useFakeTimers();
    const { handleShutdown } = await loadShutdown();
    const logger = createLogger();
    const hung = { name: 'hung', run: () => new Promise<void>(() => undefined) };

    void handleShutdown('SIGTERM', logger, [hung], TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      { event: 'shutdown_deadline_exceeded', timeoutMs: TIMEOUT_MS },
      'Shutdown deadline exceeded forcing exit',
    );
  });

  it('clears the deadline after a fast shutdown, so nothing force-exits later', async () => {
    vi.useFakeTimers();
    const { handleShutdown } = await loadShutdown();

    await handleShutdown('SIGTERM', createLogger(), [recordingStep('fast', [])], TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 2);

    expect(exit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['uncaught_exception', 'unhandled_rejection'] as const)(
    'on %s logs fatal with the error, runs every step, and keeps exit code 1',
    async (crash) => {
      const { handleCrash } = await loadShutdown();
      const logger = createLogger();
      const calls: string[] = [];
      const error = new Error('boom');

      await handleCrash(crash, error, logger, [recordingStep('a', calls)], TIMEOUT_MS);

      expect(logger.fatal).toHaveBeenCalledExactlyOnceWith(
        { event: crash, err: error },
        expect.any(String),
      );
      expect(calls).toEqual(['a']);
      expect(process.exitCode).toBe(1);
    },
  );

  it('accepts a crash value that is not an Error', async () => {
    const { handleCrash } = await loadShutdown();
    const logger = createLogger();

    await handleCrash('unhandled_rejection', 'plain text reason', logger, [], TIMEOUT_MS);

    expect(logger.fatal).toHaveBeenCalledWith(
      { event: 'unhandled_rejection', err: 'plain text reason' },
      expect.any(String),
    );
    expect(process.exitCode).toBe(1);
  });

  it('turns a running SIGTERM shutdown into exit code 1 when a crash arrives, without rerunning steps', async () => {
    const { handleCrash, handleShutdown } = await loadShutdown();
    const logger = createLogger();
    const calls: string[] = [];
    const slow = deferred();
    const steps = [
      {
        name: 'slow',
        run: () => {
          calls.push('slow');
          return slow.promise;
        },
      },
    ];

    const signal = handleShutdown('SIGTERM', logger, steps, TIMEOUT_MS);
    await handleCrash('uncaught_exception', new Error('mid-drain'), logger, steps, TIMEOUT_MS);
    slow.finish();
    await signal;

    expect(calls).toEqual(['slow']);
    expect(process.exitCode).toBe(1);
  });

  describe('installShutdownHandlers', () => {
    const added = new Map<string, Listener[]>();

    const newListeners = (event: string, before: readonly Listener[]) =>
      listenersOf(event).filter((listener) => !before.includes(listener));

    afterEach(() => {
      for (const [event, listeners] of added) {
        for (const listener of listeners) removeListener(event, listener);
      }
      added.clear();
    });

    it('installs nothing when the module is only imported', async () => {
      const before = HANDLED_EVENTS.map((event) => listenersOf(event).length);

      await loadShutdown();

      expect(HANDLED_EVENTS.map((event) => listenersOf(event).length)).toEqual(before);
    });

    it('adds exactly one listener per event, and SIGTERM runs the steps', async () => {
      const { installShutdownHandlers } = await loadShutdown();
      const before = new Map(HANDLED_EVENTS.map((event) => [event, listenersOf(event)]));
      const calls: string[] = [];

      installShutdownHandlers(createLogger(), [recordingStep('a', calls)], TIMEOUT_MS);
      for (const event of HANDLED_EVENTS) {
        added.set(event, newListeners(event, before.get(event) ?? []));
      }

      for (const event of HANDLED_EVENTS) {
        expect(added.get(event)).toHaveLength(1);
      }

      added.get('SIGTERM')?.[0]?.();
      await vi.waitFor(() => {
        expect(calls).toEqual(['a']);
      });
    });
  });
});
