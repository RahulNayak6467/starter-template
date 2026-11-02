# Setup and extension guide

## Rename a new project

1. Change the root `package.json` name and description.
2. Replace `@starter/` throughout tracked files with your package scope, including manifests,
   imports, TypeScript conditions, Vitest conditions, and Node command flags.
3. Rename `starter-api` in the API entry point, the OpenAPI title and description, and
   the project names in both Compose files.
4. Update the development and test database names and local credentials in both environment
   examples. Keep the test database name ending in `_test`. Change connection URLs together
   with their matching Compose variables; Compose does not derive URLs automatically.
5. If environment files already exist, update them too. `pnpm env:setup` never overwrites them.
6. Run `pnpm install`, `pnpm openapi:generate`, and `pnpm format`. Include the regenerated
   lockfile and OpenAPI document in your first commit.
7. Replace the README with your project's purpose and retain the relevant setup commands.
8. Run `pnpm validate`; it prepares the test stack automatically.

Search tracked files for `starter` to catch remaining names. Test fixtures can use generic
names; the package scope and custom source condition must agree everywhere.

## Environment and local services

`pnpm env:setup` creates only missing `.env` and `.env.test` files. Node loads `.env` for
development; Vitest loads `.env.test`. Existing shell variables take precedence, so unset
development `NODE_ENV` and `DATABASE_URL` before running tests in the same shell.

All service ports bind to loopback. Development PostgreSQL data uses a named Docker volume;
`pnpm services:down` preserves it. Test PostgreSQL uses temporary memory storage. Redis in
both stacks is ephemeral. The template does not create application tables.

To run multiple projects simultaneously, use unique Compose project names and host ports
in each project. Change the corresponding connection URLs whenever a host port changes.

Changing `DB_USER`, `DB_PASSWORD`, or `DB_NAME` after PostgreSQL has initialized does not
modify its existing users or database. Update PostgreSQL explicitly or deliberately remove
that project's disposable local volume before starting again.

## Tests and checks

`pnpm check` and `pnpm test:unit` need no Docker services. `pnpm test` runs all tests;
`pnpm test:integration` runs real-service tests. Both prepare missing environment files,
start PostgreSQL and Redis, wait for their health checks, and apply test migrations before
starting Vitest. Docker must be running. Existing environment files are preserved.

`pnpm validate` runs quality checks, prepares and runs integration tests, then builds and
smoke-tests the compiled API. No separate setup command is needed. The services remain
running for later tests; stop them with `pnpm test:stack:down` when finished.

Direct Vitest commands and IDE test runs bypass the pnpm setup scripts. Run
`pnpm test:stack` before launching integration tests that way. Unit tests need no test stack.

Integration tests connect only through `TEST_DATABASE_URL` and `TEST_REDIS_URL`. PostgreSQL
tests verify the configured database name against the connected server before running
administrative queries. The test migration wrapper verifies `NODE_ENV=test` and the `_test`
suffix before starting the migration tool. Use dedicated local or CI test services.

The test runner executes integration files sequentially because they share service instances.
An unreachable service is a test failure; integration tests are never silently skipped.

Unit tests cover configuration validation, logging, Redis lifecycle, errors, HTTP middleware,
health behavior, and shutdown. Integration tests exercise real connections, timeouts, recovery,
and the API process. The smoke test runs built JavaScript with production settings and checks
liveness, both dependencies, and a clean SIGTERM exit.

`pnpm test:tooling` uses Node's test runner to check environment setup, migration safeguards,
and the workspace import rules. It also runs as part of `pnpm test:unit` and `pnpm test`.
ESLint rejects paths that cross workspace boundaries, app-to-app imports, package-to-app
imports, and imports of workspace packages missing from the importing package's manifest.

## Create a migration

```sh
pnpm db:migrate:create create_users
```

Edit the generated SQL file in `packages/database/migrations/`. Put forward SQL under
`-- Up Migration` and reverse SQL under `-- Down Migration`. Apply migrations with:

```sh
pnpm db:migrate:dry-run
pnpm db:migrate
pnpm db:migrate:test
```

Migration files run in order under an advisory lock and a transaction. Do not rewrite an
already applied migration; add a new one. Keep application queries parameterized.

## Add an API feature

Create a feature directory under `apps/api/src/`, define Zod input schemas, and use the
existing HTTP validation helpers. Register feature routers in `src/http/app.ts`, normally
under `/v1`. Add schemas and operations to `src/openapi.ts`, then run
`pnpm openapi:generate`. CI checks that the generated document matches its source.

Use `AppError` for expected failures; unexpected errors produce a generic public response.
Request IDs connect responses to structured logs. Do not expose dependency failures or
stack traces in public error bodies.

## Add a package

Start from a small existing package such as `packages/config`:

1. Create `packages/<name>/package.json` with a unique `@starter/<name>` name, `private: true`,
   and `type: module`.
2. Follow the existing `exports` layout: `@starter/source` points to TypeScript source,
   `types` points to declarations, and `default` points to compiled JavaScript.
3. Add the development and build TypeScript configs. Build declarations for packages and
   exclude tests from build output.
4. Add a public `src/index.ts` and the same build, clean, typecheck, and test scripts used
   by other packages, adjusting the package test path.
5. Declare workspace dependencies with `workspace:*` and external dependencies at exact versions.
6. Run `pnpm install` and the checks.

The workspace glob and root recursive commands discover it automatically. Keep generic
packages independent of application concepts, and extract shared code when it has real users.

## Add an app

Create `apps/<name>` with its own manifest and TypeScript configs, using the API app's
source-condition and build conventions. A process entry point owns configuration, clients,
logging, and shutdown; inject those clients into the app's logic.

Declare dependencies explicitly. Apps can import packages but cannot import other apps.
ESLint discovers app package names dynamically to enforce this boundary. Root build and type
checks discover the app automatically; add its development command, process smoke test, and
CI checks as appropriate. A frontend also needs its framework-specific tooling and test setup.

## Toolchain updates and CI

When updating Node or pnpm, keep `.nvmrc`, root `package.json`, and the CI workflow in sync.
Regenerate the lockfile with the pinned pnpm version. Docker image tags include digests, and
GitHub Actions use full commit SHAs; retain both the version comments and immutable pins.

The workspace pins patched `glob` and `minimatch` versions beneath `node-pg-migrate` to
address upstream advisories. Review these overrides when upgrading the migration tool;
remove them once its own dependencies include the fixes.

The pre-commit hook formats staged supported files and lints staged TypeScript/JavaScript,
including `.mjs` tooling. CI performs full checks independently of local hooks. Secret scanning
uses the pinned Gitleaks CLI in a container with a read-only repository mount and no network.
No database or Redis secrets are needed for the disposable CI services.

Enable **Template repository** in GitHub settings once. Enable branch protection and required
checks for each new project according to how that project is maintained.
