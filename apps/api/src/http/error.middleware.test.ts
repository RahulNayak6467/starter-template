import { AppError, RETRYABLE_BY_KIND, systemClock, type ERROR_KIND } from '@starter/shared';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import request, { type Response as TestResponse } from 'supertest';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { captureLogs } from '../../test/support/capture-logs.js';
import { createErrorMiddleware } from './error.middleware.js';
import { createRequestIdMiddleware } from './request-id.middleware.js';
import { createRequestLoggerMiddleware } from './request-logger.middleware.js';
import { parseRequest } from './validation.js';

const REQUEST_ID_HEADER = 'x-request-id';

const createHarness = (
  handler: RequestHandler,
  {
    withRequestId = true,
    withRequestLogger = false,
  }: { withRequestId?: boolean; withRequestLogger?: boolean } = {},
) => {
  const logs = captureLogs();
  const app = express();
  if (withRequestId) app.use(createRequestIdMiddleware(logs.logger));
  if (withRequestLogger) app.use(createRequestLoggerMiddleware(systemClock));
  app.use(express.json({ limit: '1kb' }));
  app.all('/probe', handler);
  app.use(createErrorMiddleware(logs.logger));

  return { app, logs };
};

const throwing =
  (error: unknown): RequestHandler =>
  () => {
    throw error;
  };

const respondNoContent: RequestHandler = (_req, res) => {
  res.status(204).end();
};

const requestIdOf = (response: TestResponse): unknown => response.headers[REQUEST_ID_HEADER];

const envelope = (
  response: TestResponse,
  error: { code: string; message: string; retryable: boolean },
) => ({ error: { ...error, requestId: requestIdOf(response) } });

const internalError = { code: 'INTERNAL_ERROR', message: 'Internal error', retryable: false };

const pgUniqueViolation = () =>
  Object.assign(new Error('duplicate key value violates unique constraint "items_name_key"'), {
    code: '23505',
    constraint: 'items_name_key',
    table: 'items',
    detail: 'Key (name)=(quoted-value-123) already exists.',
  });

describe('error middleware', () => {
  describe('with an AppError', () => {
    it.each([
      ['invalid_input', 400],
      ['not_found', 404],
      ['payload_too_large', 413],
      ['internal', 500],
    ] satisfies [ERROR_KIND, number][])(
      'maps kind %s to status %i with retryable taken from the kind',
      async (kind, status) => {
        const { app } = createHarness(
          throwing(new AppError({ kind, code: 'CODE', message: 'Msg' })),
        );

        const response = await request(app).get('/probe');

        expect(response.status).toBe(status);
        expect(response.body).toEqual(
          envelope(response, { code: 'CODE', message: 'Msg', retryable: RETRYABLE_BY_KIND[kind] }),
        );
        expect(requestIdOf(response)).toEqual(expect.any(String));
      },
    );

    it('writes no log line itself for a 4xx', async () => {
      const { app, logs } = createHarness(
        throwing(new AppError({ kind: 'not_found', code: 'ITEM_NOT_FOUND', message: 'No item' })),
      );

      await request(app).get('/probe');

      expect(logs.records()).toHaveLength(0);
    });

    it('logs a 5xx once at error with its code and kind', async () => {
      const { app, logs } = createHarness(
        throwing(new AppError({ kind: 'internal', code: 'BROKEN', message: 'Broken' })),
      );

      await request(app).get('/probe');

      expect(logs.records()).toHaveLength(1);
      expect(logs.records()[0]).toMatchObject({
        severity: 'ERROR',
        event: 'request_failed',
        code: 'BROKEN',
        kind: 'internal',
        status: 500,
      });
    });
  });

  describe('with body-parser errors', () => {
    it('answers a broken JSON body with 400 INVALID_JSON and no parser details', async () => {
      const { app, logs } = createHarness(respondNoContent);

      const response = await request(app)
        .post('/probe')
        .set('content-type', 'application/json')
        .send('{"name": ');

      expect(response.status).toBe(400);
      expect(response.headers['content-type']).toMatch(/^application\/json\b/u);
      expect(response.body).toEqual(
        envelope(response, {
          code: 'INVALID_JSON',
          message: 'Request body is not valid JSON',
          retryable: false,
        }),
      );
      expect(response.text).not.toMatch(/<html|<pre|SyntaxError|\s+at\s/iu);
      expect(logs.records()).toHaveLength(0);
    });

    it('never writes broken-JSON body text to the logs', async () => {
      const { app, logs } = createHarness(respondNoContent, { withRequestLogger: true });
      const secret = ['body', 'secret', '42'].join('-');

      const response = await request(app)
        .post('/probe')
        .set('content-type', 'application/json')
        .send(`{"apiKey": ${secret}}`);

      expect(response.status).toBe(400);
      expect(logs.records()).toHaveLength(1);
      expect(logs.raw()).not.toContain(secret);
    });

    it('answers a body over the JSON limit with 413 PAYLOAD_TOO_LARGE', async () => {
      const { app } = createHarness(respondNoContent);

      const response = await request(app)
        .post('/probe')
        .set('content-type', 'application/json')
        .send(JSON.stringify({ data: 'x'.repeat(2_048) }));

      expect(response.status).toBe(413);
      expect(response.body).toEqual(
        envelope(response, {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Request body is too large',
          retryable: false,
        }),
      );
    });

    const bodyParserLikeError = (type: string, status: number, expose: boolean) =>
      Object.assign(new Error(`body-parser said ${type}`), { type, status, expose });

    it.each([
      [
        'encoding.unsupported',
        'UNSUPPORTED_CONTENT_ENCODING',
        'Request Content-Encoding is not supported',
      ],
      ['charset.unsupported', 'UNSUPPORTED_CHARSET', 'Request charset is not supported'],
      ['request.aborted', 'REQUEST_ABORTED', 'Request was aborted by the client'],
      [
        'request.size.invalid',
        'INVALID_REQUEST_BODY',
        'Request body size does not match Content-Length',
      ],
      ['some.future.type', 'INVALID_REQUEST_BODY', 'Request body could not be read'],
    ])('maps type %s to 400 %s', async (type, code, message) => {
      const { app, logs } = createHarness(throwing(bodyParserLikeError(type, 400, true)));

      const response = await request(app).get('/probe');

      expect(response.status).toBe(400);
      expect(response.body).toEqual(envelope(response, { code, message, retryable: false }));
      expect(logs.records()).toHaveLength(0);
    });

    it.each([
      [500, true],
      [500, false],
      [400, false],
    ])(
      'treats an unknown type with status %i and expose %s as an internal error',
      async (status, expose) => {
        const { app, logs } = createHarness(
          throwing(bodyParserLikeError('stream.not.readable', status, expose)),
        );

        const response = await request(app).get('/probe');

        expect(response.status).toBe(500);
        expect(response.body).toEqual(envelope(response, internalError));
        expect(logs.records()[0]).toMatchObject({
          severity: 'ERROR',
          event: 'request_failed_unexpectedly',
        });
      },
    );
  });

  describe('with a RequestValidationError from parseRequest', () => {
    const parseBody =
      (schema: z.ZodType): RequestHandler =>
      (req, res) => {
        parseRequest(schema, req.body);
        res.status(204).end();
      };

    const parseValue =
      (schema: z.ZodType, value: unknown): RequestHandler =>
      () => {
        parseRequest(schema, value);
      };

    it('returns 400 INVALID_INPUT with a dotted path for a nested field', async () => {
      const schema = z.object({ config: z.object({ model: z.string() }) });
      const { app } = createHarness(parseBody(schema));

      const response = await request(app)
        .post('/probe')
        .send({ config: { model: 42 } });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: {
          code: 'INVALID_INPUT',
          message: 'Request validation failed',
          requestId: requestIdOf(response),
          retryable: false,
          issues: [
            { path: 'config.model', message: 'Invalid input: expected string, received number' },
          ],
        },
      });
    });

    it('returns at most 10 issues when 15 fields fail', async () => {
      const shape = Object.fromEntries(
        Array.from({ length: 15 }, (_, index) => [`field${String(index)}`, z.string()]),
      );
      const { app } = createHarness(parseBody(z.object(shape)));

      const response = await request(app).post('/probe').send({});

      expect(response.body).toHaveProperty('error.issues.length', 10);
    });

    it('never echoes the rejected values in the response or the logs', async () => {
      const schema = z.object({
        name: z.string().max(3),
        mode: z.enum(['fast', 'slow']),
        count: z.number(),
      });
      const { app, logs } = createHarness(parseBody(schema), { withRequestLogger: true });

      const response = await request(app).post('/probe').send({
        name: 'rejected-name-value',
        mode: 'rejected-mode-value',
        count: 'rejected-count',
      });

      expect(response.body).toHaveProperty('error.issues.length', 3);
      for (const value of ['rejected-name-value', 'rejected-mode-value', 'rejected-count']) {
        expect(response.text).not.toContain(value);
        expect(logs.raw()).not.toContain(value);
      }
    });

    it('keeps the response and the log small when thousands of items fail', async () => {
      const fiveThousandNumbers = Array.from({ length: 5_000 }, (_, index) => index);
      const { app, logs } = createHarness(parseValue(z.array(z.string()), fiveThousandNumbers), {
        withRequestLogger: true,
      });

      const response = await request(app).get('/probe');

      expect(response.body).toHaveProperty('error.issues.length', 10);
      expect(logs.records()).toHaveLength(1);
      expect(Buffer.byteLength(logs.raw())).toBeLessThan(10 * 1024);
    });

    it('caps a long issue message at 200 characters plus an ellipsis', async () => {
      const manyLongKeys = Object.fromEntries(
        Array.from({ length: 50 }, (_, index) => [
          `unexpected_key_${String(index)}_${'k'.repeat(40)}`,
          1,
        ]),
      );
      const { app } = createHarness(parseValue(z.strictObject({}), manyLongKeys));

      const response = await request(app).get('/probe');

      expect(response.body).toHaveProperty(
        'error.issues.0.message',
        expect.stringMatching(/^Unrecognized keys:[\s\S]{182}…$/u),
      );
    });

    it('caps a long path at 200 characters plus an ellipsis', async () => {
      const longKey = 'p'.repeat(1_000);
      const { app } = createHarness(
        parseValue(z.record(z.string(), z.number()), { [longKey]: 'not-a-number' }),
      );

      const response = await request(app).get('/probe');

      expect(response.body).toHaveProperty('error.issues.0.path', `${'p'.repeat(200)}…`);
    });
  });

  it('answers a bare ZodError with 500 and no issues: bad internal data is our bug', async () => {
    const { app, logs } = createHarness(() => {
      z.object({ id: z.uuid() }).parse({ id: 1 });
    });

    const response = await request(app).get('/probe');

    expect(response.status).toBe(500);
    expect(response.body).toEqual(envelope(response, internalError));
    expect(logs.records()[0]).toMatchObject({
      event: 'request_failed_unexpectedly',
      errorDetails: { name: 'ZodError' },
    });
  });

  describe('with the request logger: one completion line per request', () => {
    it('writes one warn line for a 404, carrying the error code and no stack', async () => {
      const { app, logs } = createHarness(
        throwing(new AppError({ kind: 'not_found', code: 'ITEM_NOT_FOUND', message: 'No item' })),
        { withRequestLogger: true },
      );

      const response = await request(app).get('/probe');

      expect(logs.records()).toHaveLength(1);
      expect(logs.records()[0]).toMatchObject({
        severity: 'WARN',
        event: 'http_request_completed',
        statusCode: 404,
        errorCode: 'ITEM_NOT_FOUND',
        errorKind: 'not_found',
        requestId: requestIdOf(response),
      });
      expect(logs.raw()).not.toContain('stack');
    });

    it('writes the error details, then the completion line, for an unexpected error', async () => {
      const { app, logs } = createHarness(throwing(new Error('boom')), {
        withRequestLogger: true,
      });

      await request(app).get('/probe');

      expect(logs.records().map((record) => record.event)).toEqual([
        'request_failed_unexpectedly',
        'http_request_completed',
      ]);
      expect(logs.records()[1]).toMatchObject({
        statusCode: 500,
        errorCode: 'INTERNAL_ERROR',
        errorKind: 'internal',
      });
    });
  });

  describe('with an unknown error', () => {
    it('hides it behind a generic 500 and logs it as unexpected', async () => {
      const { app, logs } = createHarness(throwing(new Error('relation "runs" does not exist')));

      const response = await request(app).get('/probe');

      expect(response.status).toBe(500);
      expect(response.body).toEqual(envelope(response, internalError));
      expect(response.text).not.toContain('relation');
      expect(logs.records()).toHaveLength(1);
      expect(logs.records()[0]).toMatchObject({
        severity: 'ERROR',
        event: 'request_failed_unexpectedly',
        errorDetails: { name: 'Error', message: 'relation "runs" does not exist' },
      });
    });

    it('logs code, constraint and table of a database error but never its detail', async () => {
      const { app, logs } = createHarness(throwing(pgUniqueViolation()));

      const response = await request(app).get('/probe');

      expect(response.status).toBe(500);
      expect(logs.records()[0]).toMatchObject({
        errorDetails: { code: '23505', constraint: 'items_name_key', table: 'items' },
      });
      expect(logs.raw()).not.toContain('quoted-value-123');
      expect(response.text).not.toContain('quoted-value-123');
    });

    it('drops the detail at every level of a cause chain', async () => {
      const innermost = Object.assign(new Error('inner'), { detail: 'inner-detail-value' });
      const { app, logs } = createHarness(
        throwing(
          new AppError({
            kind: 'internal',
            code: 'WRAPPED',
            message: 'Wrapped',
            cause: Object.assign(pgUniqueViolation(), { cause: innermost }),
          }),
        ),
      );

      await request(app).get('/probe');

      expect(logs.records()[0]).toMatchObject({
        errorDetails: { name: 'AppError', cause: { code: '23505', cause: { message: 'inner' } } },
      });
      expect(logs.raw()).not.toContain('quoted-value-123');
      expect(logs.raw()).not.toContain('inner-detail-value');
    });

    it('treats a thrown string as unknown and logs only its type', async () => {
      const { app, logs } = createHarness(throwing('thrown-secret-value'));

      const response = await request(app).get('/probe');

      expect(response.status).toBe(500);
      expect(response.body).toEqual(envelope(response, internalError));
      expect(logs.records()[0]?.errorDetails).toEqual({ thrownType: 'string' });
      expect(logs.raw()).not.toContain('thrown-secret-value');
      expect(response.text).not.toContain('thrown-secret-value');
    });

    it('still answers with a 500 JSON envelope when the error has a throwing getter', async () => {
      const hostile = Object.defineProperty(new Error('hostile'), 'code', {
        get() {
          throw new Error('code getter failed');
        },
      });
      const { app, logs } = createHarness(throwing(hostile));

      const response = await request(app).get('/probe');

      expect(response.status).toBe(500);
      expect(response.body).toEqual(envelope(response, internalError));
      expect(logs.records()).toHaveLength(1);
      expect(logs.records()[0]?.errorDetails).toEqual({ loggingFailed: true });
    });
  });

  describe('when handling the error itself throws', () => {
    const errorWithThrowingType = () =>
      Object.defineProperty(new Error('hostile'), 'type', {
        get() {
          throw new Error('type getter failed');
        },
      });

    it('answers with a 500 JSON envelope carrying the request ID and logs one line', async () => {
      const { app, logs } = createHarness(throwing(errorWithThrowingType()));

      const response = await request(app).get('/probe');

      expect(response.status).toBe(500);
      expect(response.headers['content-type']).toMatch(/^application\/json\b/u);
      expect(response.body).toEqual(envelope(response, internalError));
      expect(logs.records()).toHaveLength(1);
      expect(logs.records()[0]).toMatchObject({
        severity: 'ERROR',
        event: 'error_middleware_failed',
        requestId: requestIdOf(response),
      });
    });

    it('uses a null requestId and the root logger without a request context', async () => {
      const { app, logs } = createHarness(throwing(errorWithThrowingType()), {
        withRequestId: false,
      });

      const response = await request(app).get('/probe');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: { ...internalError, requestId: null } });
      expect(logs.records()).toHaveLength(1);
      expect(logs.records()[0]).not.toHaveProperty('requestId');
    });
  });

  it('falls back to the root logger and a null requestId without a request context', async () => {
    const { app, logs } = createHarness(
      throwing(new AppError({ kind: 'internal', code: 'DOWN', message: 'Down' })),
      { withRequestId: false },
    );

    const response = await request(app).get('/probe');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'DOWN', message: 'Down', requestId: null, retryable: false },
    });
    expect(logs.records()[0]).toMatchObject({ event: 'request_failed', code: 'DOWN' });
    expect(logs.records()[0]).not.toHaveProperty('requestId');
  });

  it('logs and hands over to Express when the response has already started', async () => {
    const logs = captureLogs();
    const original = new Error('failed mid-stream');
    const delegated: unknown[] = [];
    const app = express();
    app.use(createRequestIdMiddleware(logs.logger));
    app.get('/probe', (_req, res, next) => {
      res.status(200).setHeader('content-type', 'text/plain');
      res.write('partial');
      next(original);
    });
    app.use(createErrorMiddleware(logs.logger));
    const recordDelegated: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
      delegated.push(error);
      res.end();
    };
    app.use(recordDelegated);

    const response = await request(app).get('/probe');

    expect(response.status).toBe(200);
    expect(response.text).toBe('partial');
    expect(delegated).toEqual([original]);
    expect(logs.records()).toHaveLength(1);
    expect(logs.records()[0]).toMatchObject({
      severity: 'ERROR',
      event: 'error_after_response_started',
      errorDetails: { message: 'failed mid-stream' },
    });
  });
});
