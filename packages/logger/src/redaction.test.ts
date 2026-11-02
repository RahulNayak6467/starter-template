import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { createRedactionOptions, REDACTION_CENSOR } from './redaction.js';

const SECRET = 'value-that-must-not-appear';

const EXPECTED_NAMES = [
  'password',
  'passphrase',
  'secret',
  'clientSecret',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'privateKey',
  'credentials',
  'connectionString',
  'databaseUrl',
  'redisUrl',
  'dsn',
  'authorization',
  'Authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'proxy-authorization',
  'body',
];

const HEADER_NAMES = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization'];

const logOnce = (fields: Record<string, unknown>): string => {
  const lines: string[] = [];
  const logger = pino(
    { redact: createRedactionOptions() },
    {
      write: (line: string) => {
        lines.push(line);
      },
    },
  );

  logger.info(fields, 'redaction-test');

  return lines.join('');
};

describe('createRedactionOptions', () => {
  it('returns a fresh policy each time so callers cannot change the shared one', () => {
    const first = createRedactionOptions();
    first.paths.push('changed');

    expect(createRedactionOptions().paths).not.toContain('changed');
  });

  it.each(EXPECTED_NAMES)('redacts %s at the log root', (name) => {
    const output = logOnce({ [name]: SECRET });

    expect(output).not.toContain(SECRET);
    expect(output).toContain(REDACTION_CENSOR);
  });

  it.each(EXPECTED_NAMES)('redacts %s one level under any parent', (name) => {
    const output = logOnce({ config: { [name]: SECRET } });

    expect(output).not.toContain(SECRET);
  });

  it.each(
    ['req', 'res', 'request', 'response'].flatMap((parent) =>
      HEADER_NAMES.map((name) => [parent, name]),
    ),
  )('redacts the %s.headers %s header', (parent, name) => {
    const output = logOnce({ [parent]: { headers: { [name]: SECRET } } });

    expect(output).not.toContain(SECRET);
  });

  it('hides a whole request body while keeping operational fields', () => {
    const output = logOnce({
      req: { method: 'POST', url: '/v1/items', body: { anything: SECRET } },
      res: { statusCode: 201 },
      durationMs: 12,
    });

    expect(output).not.toContain(SECRET);
    expect(output).toContain('"method":"POST"');
    expect(output).toContain('"url":"/v1/items"');
    expect(output).toContain('"statusCode":201');
    expect(output).toContain('"durationMs":12');
  });

  it('hides a connection URL with a password, an authorization header and a request body', () => {
    const password = ['pass', 'word', '123'].join('-');
    const output = logOnce({
      config: { databaseUrl: `postgres://user:${password}@127.0.0.1:5432/app` },
      req: { headers: { authorization: `Bearer ${SECRET}` }, body: { note: SECRET } },
    });

    expect(output).not.toContain(password);
    expect(output).not.toContain(SECRET);
  });

  it('keeps fields that are not sensitive', () => {
    const output = logOnce({ requestId: 'request-123', service: 'api' });

    expect(output).toContain('"requestId":"request-123"');
    expect(output).not.toContain(REDACTION_CENSOR);
  });

  it('does not change the object given to the logger', () => {
    const fields = { password: SECRET, req: { headers: { authorization: SECRET } } };

    logOnce(fields);

    expect(fields).toEqual({ password: SECRET, req: { headers: { authorization: SECRET } } });
  });
});
