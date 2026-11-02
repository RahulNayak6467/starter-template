# Repository conventions

This is a pnpm workspace with TypeScript ESM apps in `apps/` and reusable packages in
`packages/`. Read the README and `docs/getting-started.md` before changing the structure.

## Commands

- `pnpm env:setup`: create missing local environment files.
- `pnpm check`: formatting, lint, type checks, OpenAPI freshness, and unit tests.
- `pnpm test`: prepare test services and run all unit/integration tests; requires Docker.
- `pnpm test:integration`: prepare test services and run real-service tests.
- `pnpm test:stack`: create missing environment files, start PostgreSQL/Redis test services,
  and apply test migrations.
- `pnpm validate`: all checks, integration tests, builds, and compiled API smoke test;
  prepares its test stack automatically and requires Docker.
- `pnpm test:stack:down`: stop the test services.
- `pnpm test:tooling`: check setup, migration guards, and workspace-boundary rules without Docker.
- `pnpm openapi:generate`: regenerate the API document after contract changes.

## Implementation

- Apps import packages, never other apps. Packages never import apps. Avoid dependency cycles.
- Import other workspaces by package name, with dependencies declared in their manifests.
- Keep TypeScript strict. Validate untrusted input with Zod; use `unknown` at boundaries.
- Read environment variables in app config or `packages/config`; pass validated config onward.
- Create clients in the process entry point and inject them. Release resources during shutdown.
- Use parameterized SQL, one PostgreSQL pool per process, and ordered SQL migrations.
- Keep logs structured; omit credentials, raw request bodies, and private data.
- Keep dependency versions exact, update the lockfile, and retain immutable CI/image pins.
- Keep source conditions consistent across package exports, TypeScript, Node scripts, and Vitest.
- Add tests for changed behavior. Keep real-service tests in `test/integration/` and unit tests
  beside source. Use dedicated `TEST_*` services for integration tests and migrations.
- Regenerate OpenAPI after changing documented routes or schemas. Run appropriate checks.

## Scope

Keep the starter generic. Add frameworks, queues, deployment tooling, authentication, or
business features only when requested. Do not copy real secrets or local environment files
into tracked examples. Do not commit or push unless requested.
