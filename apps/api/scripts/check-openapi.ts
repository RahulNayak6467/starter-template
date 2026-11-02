import { readFileSync } from 'node:fs';

import { buildOpenApiDocument } from '../src/openapi.js';

const committed: unknown = JSON.parse(
  readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'),
);
if (JSON.stringify(committed) !== JSON.stringify(buildOpenApiDocument())) {
  throw new Error(
    'apps/api/openapi.json is stale. Run pnpm openapi:generate and include the result.',
  );
}

console.info('OpenAPI document is up to date.');
