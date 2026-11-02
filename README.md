# TypeScript Monorepo Starter

A backend starter with pnpm workspaces, strict TypeScript, Express, PostgreSQL, and Redis.
Includes validated configuration, structured logging, request middleware, health probes,
SQL migrations, OpenAPI generation, tests, and GitHub Actions.

## Start a project

On GitHub, enable **Settings → General → Template repository** for this repository.
For a new project, select **Use this template → Create a new repository**, then clone it.

Requirements: Node.js **24.22.2**, pnpm **12.16.1**, and Docker with Compose v2.
The exact versions are recorded in `.nvmrc` and `package.json`.

```sh
nvm install
nvm use
npm install --global pnpm@12.16.1
pnpm install --frozen-lockfile
pnpm env:setup
pnpm services:up
pnpm db:migrate
pnpm dev
```

`pnpm env:setup` creates `.env` and `.env.test` from examples and preserves existing files.
The example credentials are for local development. PostgreSQL uses host port `55432`,
Redis uses `56379`, and the API uses `8000`.

```sh
curl http://localhost:8000/health/live
curl http://localhost:8000/health/ready
```

Liveness reports whether HTTP is running. Readiness requires both PostgreSQL and Redis;
it returns `503` while either is unavailable or the process is shutting down.

## Layout

```text
apps/
  api/          Express process, middleware, health probes, OpenAPI
packages/
  config/       Zod environment validation
  database/     PostgreSQL pool, health query, SQL migrations
  logger/       Pino logging, redaction, error serialization
  redis/        Redis client, bounded commands, reconnects, shutdown
  shared/       Errors, clock, graceful process shutdown
scripts/        Environment setup and compiled API smoke test
docs/           Setup, renaming, and extension guide
.github/        CI and dependency updates
```

Apps import packages, never other apps. Packages never import apps. ESLint enforces these
import boundaries, including new apps. Keep package dependencies free of cycles.

## Commands

| Command                                       | Purpose                                                        |
| --------------------------------------------- | -------------------------------------------------------------- |
| `pnpm env:setup`                              | Create missing environment files                               |
| `pnpm services:up` / `pnpm services:down`     | Start / stop development PostgreSQL and Redis                  |
| `pnpm dev`                                    | Run the API with TypeScript source and watch mode              |
| `pnpm build` / `pnpm start`                   | Build all workspaces / run the compiled API                    |
| `pnpm check`                                  | Formatting, lint, types, OpenAPI freshness, unit tests         |
| `pnpm test`                                   | Prepare test services and run all unit/integration tests       |
| `pnpm test:unit` / `pnpm test:watch`          | Run / watch tests without external services                    |
| `pnpm test:stack`                             | Create missing environment files, start test services, migrate |
| `pnpm test:integration`                       | Prepare test services and test PostgreSQL, Redis, and the API  |
| `pnpm test:smoke`                             | Check the compiled API against the test services               |
| `pnpm validate`                               | Run all checks, integration tests, build, and smoke test       |
| `pnpm test:stack:down`                        | Stop and remove test services                                  |
| `pnpm db:migrate:create <name>`               | Create an SQL migration                                        |
| `pnpm db:migrate` / `pnpm db:migrate:dry-run` | Apply / preview development migrations                         |
| `pnpm openapi:generate`                       | Regenerate `apps/api/openapi.json` after contract changes      |
| `pnpm format` / `pnpm clean`                  | Format source / remove build output                            |

For a complete local verification:

```sh
pnpm validate
pnpm test:stack:down
```

The test stack uses PostgreSQL on `55433` and Redis on `56380`. Tests consume `TEST_*`
connection URLs, and test migrations refuse database names that do not end with `_test`.
PostgreSQL test data lives in memory and disappears when its container is removed.

`pnpm test`, `pnpm test:integration`, and `pnpm validate` prepare the test environment and
services automatically. Docker must be running. Services remain available afterward;
stop them with `pnpm test:stack:down`. For tests without Docker, use `pnpm test:unit`.

## Conventions

- Read and validate environment variables in `src/config.ts`; inject dependencies elsewhere.
- Use `src/main.ts` for process startup; construct the Express app separately for tests.
- Write unit tests beside source as `*.test.ts`; put real-service tests in `test/integration/`.
- Import workspace packages by name, such as `@starter/logger`.
- Use parameterized SQL and create migrations under `packages/database/migrations/`.
- Keep secrets out of logs. Redaction covers known structured fields; avoid embedding
  credentials or private data in free-text messages.
- Redis has persistence disabled and uses `noeviction`; adjust this intentionally if your
  application needs durable Redis data or a cache eviction policy.

Development and tests resolve package source through the `@starter/source` export condition.
Production runs use compiled `dist/` exports. Build all workspaces before `pnpm start`.
`pnpm start` also loads an optional local `.env`; exported environment variables take
precedence. Production environments should supply their configuration with `NODE_ENV=production`
and `LOG_PRETTY=false`.

## Make it yours

Follow [the setup and extension guide](docs/getting-started.md) to rename packages, run
multiple projects locally, add an app or package, and create your first migration.

CI checks formatting, lint, types, API documentation, unit and integration tests, production
dependency advisories, the compiled API with production dependencies only, and secrets. Dependencies, runtime versions, Docker
images, and GitHub Actions are pinned; Dependabot proposes updates.

The starter contains no application schema, authentication, frontend, queues, cloud
infrastructure, or deployment configuration. Add those when your project needs them.
