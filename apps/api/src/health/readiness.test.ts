import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createReadinessChecker, type ReadinessOptions } from './readiness.js';

const TIMEOUT_MS = 1_000;

const createHarness = () => {
  const query = vi.fn<() => Promise<unknown>>().mockResolvedValue({ rows: [{ result: 1 }] });
  const ping = vi.fn<() => Promise<unknown>>().mockResolvedValue('PONG');
  const logger = { warn: vi.fn(), info: vi.fn() };
  let draining = false;
  const check = createReadinessChecker({
    // pg's overloaded query type can't be met by a mock.
    databasePool: { query } as unknown as ReadinessOptions['databasePool'],
    checkRedis: ping,
    isDraining: () => draining,
    timeoutMs: TIMEOUT_MS,
    logger,
  });

  return {
    query,
    ping,
    logger,
    check,
    startDraining: () => {
      draining = true;
    },
  };
};

const deferredQuery = () => {
  let settle: { resolve: () => void; reject: (error: Error) => void } | undefined;
  const promise = new Promise<unknown>((resolve, reject) => {
    settle = { resolve: () => resolve({ rows: [] }), reject };
  });
  return {
    promise,
    resolve: () => settle?.resolve(),
    reject: (error: Error) => settle?.reject(error),
  };
};

describe('readiness checker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is ready when PostgreSQL answers before the deadline, and leaves no timer behind', async () => {
    const { query, logger, check } = createHarness();

    await expect(check()).resolves.toEqual({ status: 'ready' });

    expect(query).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports database_unavailable and logs the error on the first failure', async () => {
    const { query, logger, check } = createHarness();
    const databaseError = new Error('connection refused');
    query.mockRejectedValue(databaseError);

    await expect(check()).resolves.toEqual({
      status: 'not_ready',
      reason: 'database_unavailable',
    });

    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      { event: 'readiness_failed', reason: 'database_unavailable', err: databaseError },
      'Readiness check started failing',
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports redis_unavailable until Redis recovers', async () => {
    const { ping, logger, check } = createHarness();
    const error = new Error('Redis connection refused');
    ping.mockRejectedValue(error);

    await expect(check()).resolves.toEqual({ status: 'not_ready', reason: 'redis_unavailable' });
    await check();
    expect(logger.warn).toHaveBeenCalledOnce();

    ping.mockResolvedValue('PONG');
    await expect(check()).resolves.toEqual({ status: 'ready' });
    expect(logger.info).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds an unresponsive Redis check with the readiness deadline', async () => {
    const { ping, check } = createHarness();
    ping.mockImplementation(() => new Promise(() => undefined));

    const result = check();
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    await expect(result).resolves.toEqual({ status: 'not_ready', reason: 'timeout' });
  });

  it('reports draining when shutdown starts during a dependency check', async () => {
    const { query, check, startDraining } = createHarness();
    const pending = deferredQuery();
    query.mockReturnValueOnce(pending.promise);

    const result = check();
    startDraining();
    pending.resolve();

    await expect(result).resolves.toEqual({ status: 'not_ready', reason: 'draining' });
  });

  it('reports timeout when PostgreSQL never answers', async () => {
    const { query, logger, check } = createHarness();
    query.mockImplementation(() => new Promise(() => undefined));

    const result = check();
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    await expect(result).resolves.toEqual({ status: 'not_ready', reason: 'timeout' });
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      { event: 'readiness_failed', reason: 'timeout', timeoutMs: TIMEOUT_MS },
      'Readiness check started failing',
    );
  });

  it('reports draining without querying, starting a timer or logging', async () => {
    const { query, logger, check, startDraining } = createHarness();
    startDraining();

    await expect(check()).resolves.toEqual({ status: 'not_ready', reason: 'draining' });

    expect(query).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('logs a 30-probe outage as two lines: one when it starts, one when it ends', async () => {
    const { query, logger, check } = createHarness();
    query.mockRejectedValue(new Error('connection refused'));

    for (let probe = 0; probe < 30; probe += 1) {
      await check();
    }
    query.mockResolvedValue({ rows: [] });
    await check();
    await check();

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      { event: 'readiness_recovered' },
      'Readiness check recovered',
    );
  });

  it('logs a second outage again', async () => {
    const { query, logger, check } = createHarness();

    query.mockRejectedValueOnce(new Error('first outage'));
    await check();
    await check();
    query.mockRejectedValueOnce(new Error('second outage'));
    await check();
    await check();

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledTimes(2);
  });

  it('shares one unfinished query between overlapping probes', async () => {
    const { query, check } = createHarness();
    const pending = deferredQuery();
    query.mockReturnValueOnce(pending.promise);

    const probes = [check(), check(), check()];
    pending.resolve();

    await expect(Promise.all(probes)).resolves.toEqual([
      { status: 'ready' },
      { status: 'ready' },
      { status: 'ready' },
    ]);
    expect(query).toHaveBeenCalledOnce();
  });

  it('logs one line when overlapping probes share a failing query', async () => {
    const { query, logger, check } = createHarness();
    const pending = deferredQuery();
    query.mockReturnValueOnce(pending.promise);

    const probes = [check(), check(), check()];
    pending.reject(new Error('connection refused'));
    await Promise.all(probes);

    expect(query).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('starts a fresh query once a timed-out one finally settles', async () => {
    const { query, check } = createHarness();
    const pending = deferredQuery();
    query.mockReturnValueOnce(pending.promise);

    const timedOut = check();
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await expect(timedOut).resolves.toEqual({ status: 'not_ready', reason: 'timeout' });

    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);

    await expect(check()).resolves.toEqual({ status: 'ready' });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('keeps sharing a query that is still hung after a timeout', async () => {
    const { query, check } = createHarness();
    query.mockImplementation(() => new Promise(() => undefined));

    const first = check();
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await first;
    const second = check();
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await second;

    expect(query).toHaveBeenCalledOnce();
  });
});
