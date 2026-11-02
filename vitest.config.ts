import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// Loaded here so root, filtered and IDE runs all see the same TEST_* variables.
const testEnvFile = resolve(import.meta.dirname, '.env.test');
if (existsSync(testEnvFile)) process.loadEnvFile(testEnvFile);

// loadEnvFile doesn't override shell variables, so a real database could reach tests.
const refuseToRunTests = (reason: string): never => {
  throw new Error(`Refusing to run tests: ${reason}`);
};

if (process.env.NODE_ENV !== undefined && process.env.NODE_ENV !== 'test') {
  refuseToRunTests(`NODE_ENV is "${process.env.NODE_ENV}", expected "test"`);
}

const shellDatabaseUrl = process.env.DATABASE_URL;
if (shellDatabaseUrl !== undefined) {
  let databaseName = '';
  try {
    databaseName = decodeURIComponent(new URL(shellDatabaseUrl).pathname.slice(1));
  } catch {
    refuseToRunTests('DATABASE_URL is set but is not a valid URL; unset it');
  }
  if (!databaseName.endsWith('_test')) {
    refuseToRunTests(
      `DATABASE_URL points at database "${databaseName}", which doesn't end in _test; unset it`,
    );
  }
}

const conditions = ['@starter/source', ...defaultServerConditions];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    environment: 'node',
    isolate: true,
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    testTimeout: 5_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['{apps,packages}/*/src/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          // One file at a time: they share one test database.
          name: 'integration',
          include: ['{apps,packages}/*/test/integration/**/*.test.ts', 'tests/**/*.test.ts'],
          fileParallelism: false,
          hookTimeout: 30_000,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
