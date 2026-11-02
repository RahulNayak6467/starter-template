import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

import { createWorkspaceBoundaryRule } from './scripts/workspace-boundaries.mjs';

const envAccess = [
  {
    selector: "MemberExpression[object.name='process'][property.name='env']",
    message: "Read process.env only in an app's src/config.ts or in packages/config.",
  },
  {
    selector: "MemberExpression[object.name='process'][computed=true][property.value='env']",
    message: "Read process.env only in an app's src/config.ts or in packages/config.",
  },
];

const workspaces = ['apps', 'packages'].flatMap((folder) =>
  readdirSync(new URL(`./${folder}/`, import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const directory = new URL(`./${folder}/${entry.name}/`, import.meta.url);
      const manifestPath = new URL('package.json', directory);
      if (!existsSync(manifestPath)) return [];
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      return [
        {
          name: manifest.name,
          directory: fileURLToPath(directory),
          kind: folder === 'apps' ? 'app' : 'package',
          dependencies: {
            ...manifest.dependencies,
            ...manifest.devDependencies,
            ...manifest.peerDependencies,
            ...manifest.optionalDependencies,
          },
        },
      ];
    }),
);

export default defineConfig(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'],
  },
  {
    files: ['**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: {
        AbortSignal: 'readonly',
        URL: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['vitest.config.ts', 'apps/*/vitest.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['apps/**/*.{ts,js,mjs}', 'packages/**/*.{ts,js,mjs}'],
    plugins: { workspace: { rules: { boundaries: createWorkspaceBoundaryRule(workspaces) } } },
    rules: { 'workspace/boundaries': 'error' },
  },
  {
    files: ['apps/*/src/**/*.ts', 'packages/*/src/**/*.ts'],
    ignores: ['apps/*/src/config.ts', 'packages/config/src/**'],
    rules: {
      'no-restricted-syntax': ['error', ...envAccess],
    },
  },
);
