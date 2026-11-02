import { EventEmitter } from 'node:events';

import { systemClock } from '@starter/shared';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { captureLogs } from '../../test/support/capture-logs.js';
import { createRequestIdMiddleware } from './request-id.middleware.js';
import { createRequestLoggerMiddleware, requestLogLevel } from './request-logger.middleware.js';

const createClock = (startTime: number, endTime: number) => ({
  nowMs: () => 0,
  monotonicMs: vi.fn<() => number>().mockReturnValueOnce(startTime).mockReturnValueOnce(endTime),
});

const createHarness = ({
  startTime = 1_000,
  endTime = 1_025,
  method = 'GET',
  url = '/probe?token=query-secret',
  statusCode = 200,
  headersSent = true,
  writableFinished = false,
  quietPaths = [] as readonly string[],
} = {}) => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const req = {
    method,
    originalUrl: url,
    requestContext: { requestId: 'request-123', clientRequestId: undefined, logger },
  } as unknown as Request;
  const response = Object.assign(new EventEmitter(), { statusCode, headersSent, writableFinished });
  const clock = createClock(startTime, endTime);
  const next = vi.fn();

  createRequestLoggerMiddleware(clock, { quietPaths })(req, response as unknown as Response, next);

  return { logger, next, clock, response };
};

describe('requestLogLevel', () => {
  it.each([
    [null, 'warn'],
    [200, 'info'],
    [399, 'info'],
    [400, 'warn'],
    [499, 'warn'],
    [500, 'error'],
    [503, 'error'],
  ] as const)('maps status %s to %s', (status, level) => {
    expect(requestLogLevel(status)).toBe(level);
  });
});

describe('request logger middleware', () => {
  it('calls next at once and logs exactly once when finish is followed by close', () => {
    const { logger, next, response } = createHarness();

    expect(next).toHaveBeenCalledOnce();
    expect(logger.info).not.toHaveBeenCalled();

    response.emit('finish');
    response.writableFinished = true;
    response.emit('close');

    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      {
        event: 'http_request_completed',
        method: 'GET',
        path: '/probe',
        statusCode: 200,
        durationMs: 25,
        outcome: 'completed',
      },
      'HTTP request completed',
    );
  });

  it('never logs the query string', () => {
    const { logger, response } = createHarness();

    response.emit('finish');

    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('query-secret');
  });

  it.each([
    [204, 'info'],
    [404, 'warn'],
    [500, 'error'],
  ] as const)('logs a completed %i response at %s', (statusCode, level) => {
    const { logger, response } = createHarness({ statusCode });

    response.emit('finish');

    expect(logger[level]).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode, outcome: 'completed' }),
      'HTTP request completed',
    );
  });

  it('logs an abort before the headers at warn with a null status', () => {
    const { logger, response } = createHarness({ method: 'POST', headersSent: false });

    response.emit('close');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST', statusCode: null, outcome: 'aborted' }),
      'HTTP request aborted',
    );
  });

  it('logs an abort after the headers at warn, even for a 5xx', () => {
    const { logger, response } = createHarness({ statusCode: 503 });

    response.emit('close');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 503, outcome: 'aborted' }),
      'HTTP request aborted',
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('treats a close after the response finished writing as completed', () => {
    const { logger, response } = createHarness({ statusCode: 204, writableFinished: true });

    response.emit('close');

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 204, outcome: 'completed' }),
      'HTTP request completed',
    );
  });

  it('keeps the first outcome when close is followed by finish', () => {
    const { logger, clock, response } = createHarness({ headersSent: false });

    response.emit('close');
    response.emit('finish');

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.info).not.toHaveBeenCalled();
    expect(clock.monotonicMs).toHaveBeenCalledTimes(2);
  });

  it('measures duration with the monotonic clock and never goes negative', () => {
    const { logger, response } = createHarness({ startTime: 1_000, endTime: 900 });

    response.emit('finish');

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ durationMs: 0 }),
      'HTTP request completed',
    );
  });

  it('logs a GET to a quiet path at debug only', () => {
    const { logger, response } = createHarness({
      url: '/health/live',
      quietPaths: ['/health/live'],
    });

    response.emit('finish');

    expect(logger.debug).toHaveBeenCalledOnce();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('logs other methods on a quiet path at their normal level', () => {
    const { logger, response } = createHarness({
      method: 'POST',
      url: '/health/live',
      quietPaths: ['/health/live'],
      statusCode: 404,
    });

    response.emit('finish');

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('logs the full path for a route inside a mounted router', async () => {
    const logs = captureLogs();
    const app = express();
    app.use(createRequestIdMiddleware(logs.logger));
    app.use(createRequestLoggerMiddleware(systemClock));
    const router = express.Router();
    router.get('/runs', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    app.use('/v1', router);

    await request(app).get('/v1/runs?token=query-secret');

    await vi.waitFor(() => {
      expect(logs.records()).toHaveLength(1);
    });
    expect(logs.records()[0]).toMatchObject({ path: '/v1/runs', statusCode: 200 });
    expect(logs.raw()).not.toContain('query-secret');
  });

  it('writes the request ID once, from the child logger binding', async () => {
    const logs = captureLogs();
    const app = express();
    app.use(createRequestIdMiddleware(logs.logger));
    app.use(createRequestLoggerMiddleware(systemClock));
    app.get('/probe', (_req, res) => {
      res.status(204).end();
    });

    const response = await request(app).get('/probe');

    await vi.waitFor(() => {
      expect(logs.records()).toHaveLength(1);
    });
    expect(logs.raw().match(/"requestId":/gu)).toHaveLength(1);
    expect(logs.records()[0]).toMatchObject({ requestId: response.headers['x-request-id'] });
  });
});
