import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { Linter } from 'eslint';

import { createWorkspaceBoundaryRule } from './workspace-boundaries.mjs';

const root = resolve('/workspace');
const workspaces = [
  {
    name: '@example/api',
    kind: 'app',
    directory: resolve(root, 'apps/api'),
    dependencies: { '@example/logger': 'workspace:*' },
  },
  {
    name: '@example/worker',
    kind: 'app',
    directory: resolve(root, 'apps/worker'),
    dependencies: {},
  },
  {
    name: '@example/logger',
    kind: 'package',
    directory: resolve(root, 'packages/logger'),
    dependencies: {},
  },
  {
    name: '@example/shared',
    kind: 'package',
    directory: resolve(root, 'packages/shared'),
    dependencies: {},
  },
];

const lint = (file, code) =>
  new Linter({ cwd: root }).verify(
    code,
    [
      {
        files: ['**/*.js'],
        plugins: { workspace: { rules: { boundaries: createWorkspaceBoundaryRule(workspaces) } } },
        rules: { 'workspace/boundaries': 'error' },
      },
    ],
    { filename: resolve(root, file) },
  );

for (const [name, file, code, messageId] of [
  [
    'package sibling relative import',
    'packages/logger/src/index.js',
    'import "../../shared/src/index.js";',
    'relativeWorkspace',
  ],
  [
    'absolute workspace import',
    'apps/api/src/main.js',
    `import "${resolve(root, 'packages/logger/src/index.js')}";`,
    'relativeWorkspace',
  ],
  [
    'app sibling relative import',
    'apps/api/src/main.js',
    'import "../../worker/src/main.js";',
    'appImport',
  ],
  ['named app import', 'apps/api/src/main.js', 'import "@example/worker";', 'appImport'],
  [
    'package to app import',
    'packages/logger/src/index.js',
    'import "@example/api";',
    'packageImportApp',
  ],
  [
    'package to app relative import',
    'packages/logger/src/index.js',
    'import "../../../apps/api/src/main.js";',
    'packageImportApp',
  ],
  [
    'undeclared named workspace dependency',
    'apps/api/src/main.js',
    'import "@example/shared";',
    'undeclaredDependency',
  ],
  [
    'undeclared workspace subpath',
    'apps/api/src/main.js',
    'import "@example/shared/errors";',
    'undeclaredDependency',
  ],
  [
    'cross workspace re-export',
    'packages/logger/src/index.js',
    'export * from "../../shared/src/index.js";',
    'relativeWorkspace',
  ],
  [
    'cross workspace named re-export',
    'packages/logger/src/index.js',
    'export { clock } from "../../shared/src/index.js";',
    'relativeWorkspace',
  ],
  [
    'cross workspace dynamic import',
    'packages/logger/src/index.js',
    'import("../../shared/src/index.js");',
    'relativeWorkspace',
  ],
  [
    'cross workspace template import',
    'packages/logger/src/index.js',
    'import(`../../shared/src/index.js`);',
    'relativeWorkspace',
  ],
  [
    'cross workspace require',
    'packages/logger/src/index.js',
    'require("../../shared/src/index.js");',
    'relativeWorkspace',
  ],
]) {
  test(`rejects ${name}`, () => {
    const messages = lint(file, code);
    assert.equal(messages.length, 1, JSON.stringify(messages));
    assert.equal(messages[0].messageId, messageId);
  });
}

for (const [name, file, code] of [
  ['declared package import', 'apps/api/src/main.js', 'import "@example/logger";'],
  ['declared package subpath', 'apps/api/src/main.js', 'import "@example/logger/format";'],
  ['local relative import', 'apps/api/src/http/app.js', 'import "../config.js";'],
  ['own package import', 'packages/logger/src/index.js', 'import "@example/logger";'],
  ['external dependency', 'apps/api/src/main.js', 'import "express";'],
  ['Node built-in', 'packages/logger/src/index.js', 'import "node:fs";'],
  ['nonworkspace tooling', 'scripts/tool.js', 'import "@example/shared";'],
]) {
  test(`allows ${name}`, () => assert.deepEqual(lint(file, code), []));
}
