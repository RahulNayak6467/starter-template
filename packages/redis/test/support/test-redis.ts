import { createServer } from 'node:net';

const requireEnv = (name: string): string => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Redis integration tests require NODE_ENV=test');
  }

  const value = process.env[name];

  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for integration tests (see .env.test.example)`);
  }

  return value;
};

// TEST_* only: a REDIS_URL exported in the shell must never reach these tests.
export const requireTestRedisUrl = (): string => requireEnv('TEST_REDIS_URL');

export const findClosedPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Expected a TCP address'));
        return;
      }

      server.close(() => {
        resolve(address.port);
      });
    });
  });
