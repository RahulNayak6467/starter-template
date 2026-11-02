export const REDACTION_CENSOR = '[REDACTED]';

export const SENSITIVE_FIELD_NAMES = [
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
] as const;

const HEADER_PARENTS = ['req.headers', 'res.headers', 'request.headers', 'response.headers'];

const HEADER_NAMES = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization'];

const isIdentifier = (name: string): boolean => /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name);

const child = (parent: string, name: string): string =>
  isIdentifier(name) ? `${parent}.${name}` : `${parent}[${JSON.stringify(name)}]`;

const root = (name: string): string => (isIdentifier(name) ? name : `[${JSON.stringify(name)}]`);

export interface RedactionOptions {
  paths: string[];
  censor: string;
}

export const createRedactionOptions = (): RedactionOptions => ({
  paths: [
    ...SENSITIVE_FIELD_NAMES.map(root),
    ...SENSITIVE_FIELD_NAMES.map((name) => child('*', name)),
    ...HEADER_PARENTS.flatMap((parent) => HEADER_NAMES.map((name) => child(parent, name))),
  ],
  censor: REDACTION_CENSOR,
});
