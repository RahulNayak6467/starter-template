import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { systemClock } from '@starter/shared';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { silentLogger } from '../test/support/capture-logs.js';
import { createApp, MAX_REQUEST_BODY_BYTES } from './http/app.js';
import type { ReadinessChecker } from './health/readiness.js';
import { REQUEST_ID_HEADER } from './http/request-id.middleware.js';

const ready: ReadinessChecker = () => Promise.resolve({ status: 'ready' });
const draining: ReadinessChecker = () =>
  Promise.resolve({ status: 'not_ready', reason: 'draining' });

const createTestApp = (checkReadiness: ReadinessChecker = ready) =>
  createApp({ logger: silentLogger(), clock: systemClock, checkReadiness });

// A small actual body, so the early 413 can't race a large upload.
const sendDeclaredOversizedBody = () =>
  request(createTestApp())
    .post('/anything')
    .set('content-type', 'application/json')
    .set('content-length', String(MAX_REQUEST_BODY_BYTES + 1))
    .send('{}');

const sendBrokenJson = () =>
  request(createTestApp())
    .post('/health/live')
    .set('content-type', 'application/json')
    .send('{"broken": ');

const envelope = (response: request.Response, code: string, message: string) => ({
  error: { code, message, requestId: response.headers[REQUEST_ID_HEADER], retryable: false },
});

describe('createApp', () => {
  it('mounts liveness and readiness under /health', async () => {
    const live = await request(createTestApp()).get('/health/live');
    const readiness = await request(createTestApp(draining)).get('/health/ready');

    expect(live.status).toBe(200);
    expect(readiness.status).toBe(503);
    expect(readiness.body).toEqual({ status: 'not_ready' });
  });

  it.each([
    ['a 200', () => request(createTestApp()).get('/health/live')],
    ['a 404', () => request(createTestApp()).get('/nope')],
    ['a broken-JSON 400', sendBrokenJson],
    ['an early 413', sendDeclaredOversizedBody],
    ['a 503', () => request(createTestApp(draining)).get('/health/ready')],
  ])('sends a request ID and the security headers on %s', async (_label, send) => {
    const response = await send();

    expect(response.headers[REQUEST_ID_HEADER]).toEqual(expect.any(String));
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('answers an unknown route with the 404 envelope', async () => {
    const response = await request(createTestApp()).get('/nope');

    expect(response.status).toBe(404);
    expect(response.body).toEqual(envelope(response, 'ROUTE_NOT_FOUND', 'Route not found'));
  });

  it.each(['post', 'put', 'patch', 'delete'] as const)(
    'answers %s /health/live with the 404 envelope',
    async (method) => {
      const response = await request(createTestApp())[method]('/health/live');

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ error: { code: 'ROUTE_NOT_FOUND' } });
    },
  );

  it('puts the request ID into a body-parser error, so the ID runs before parsing', async () => {
    const response = await sendBrokenJson();

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      envelope(response, 'INVALID_JSON', 'Request body is not valid JSON'),
    );
  });

  it('rejects a declared body over the limit with the 413 envelope', async () => {
    const response = await sendDeclaredOversizedBody();

    expect(response.status).toBe(413);
    expect(response.body).toEqual(
      envelope(response, 'PAYLOAD_TOO_LARGE', 'Request body is too large'),
    );
  });

  it('never trusts a client request ID in the error body', async () => {
    const response = await request(createTestApp())
      .get('/nope')
      .set(REQUEST_ID_HEADER, 'client-chosen-id');

    expect(response.headers[REQUEST_ID_HEADER]).not.toBe('client-chosen-id');
    expect(response.body).toMatchObject({
      error: { requestId: response.headers[REQUEST_ID_HEADER] },
    });
  });

  it.each([
    ['unknown route', () => request(createTestApp()).get('/nope')],
    ['broken JSON', sendBrokenJson],
    ['oversized body', sendDeclaredOversizedBody],
  ])('sends the %s error as JSON, never as an HTML page', async (_label, send) => {
    const response = await send();

    expect(response.headers['content-type']).toMatch(/^application\/json\b/u);
    expect(response.text).not.toMatch(/<!doctype|<html|<pre/iu);
  });

  describe('body limit over a real socket', () => {
    const CHUNK = Buffer.alloc(64 * 1024, 'x');
    const ANSWER_DEADLINE_MS = 2_000;
    const servers: http.Server[] = [];

    afterEach(async () => {
      for (const server of servers.splice(0)) {
        server.closeAllConnections();
        server.close();
        await once(server, 'close');
      }
    });

    const listen = async () => {
      const bytesReadAtAnswer: number[] = [];
      const server = http.createServer(createTestApp());
      server.prependListener('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
        res.on('finish', () => bytesReadAtAnswer.push(req.socket.bytesRead));
      });
      servers.push(server);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const { port } = server.address() as AddressInfo;
      return { port, bytesReadAtAnswer };
    };

    const startPost = (port: number, headers: http.OutgoingHttpHeaders) => {
      const req = http.request({ port, host: '127.0.0.1', method: 'POST', path: '/x', headers });
      req.on('error', () => undefined);
      const status = new Promise<number | undefined>((resolve) => {
        const deadline = setTimeout(() => resolve(undefined), ANSWER_DEADLINE_MS);
        req.once('response', (res: http.IncomingMessage) => {
          clearTimeout(deadline);
          res.resume();
          resolve(res.statusCode);
        });
      });
      return { req, status };
    };

    it('answers a declared 50 MB body with 413 after reading only the first chunk', async () => {
      const { port, bytesReadAtAnswer } = await listen();
      const { req, status } = startPost(port, {
        'content-type': 'application/json',
        'content-length': 50 * 1024 * 1024,
      });

      req.write(CHUNK);

      expect(await status).toBe(413);
      req.destroy();
      expect(bytesReadAtAnswer[0]).toBeLessThan(MAX_REQUEST_BODY_BYTES);
    });

    it('answers a chunked body over the limit with 413 instead of buffering all of it', async () => {
      const { port } = await listen();
      const { req, status } = startPost(port, {
        'content-type': 'application/json',
        'transfer-encoding': 'chunked',
      });

      for (let sent = 0; sent < 3 * MAX_REQUEST_BODY_BYTES; sent += CHUNK.length) {
        if (!req.write(CHUNK)) await once(req, 'drain');
      }
      req.end();

      expect(await status).toBe(413);
    });
  });
});
