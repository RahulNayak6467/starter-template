import { writeFileSync } from 'node:fs';

import { buildOpenApiDocument } from '../src/openapi.js';

const outputPath = new URL('../openapi.json', import.meta.url);

writeFileSync(outputPath, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
