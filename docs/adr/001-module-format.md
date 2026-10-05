# ADR-001 — Server module format: ESM

- Status: accepted
- Date: 2026-09-26

## Context and decision

Use ESM for the NestJS 12 server: `"type": "module"`, TypeScript `module: nodenext`, and `.js` suffixes on relative imports. Build decorated server code with TypeScript before running it; do not use tsx or Node type stripping because they do not provide the required decorator metadata.

Node 22 loads the selected CommonJS dependencies through its ESM interoperability. The integration checks exercised CLS transactions, TypeORM, logging, throttling and i18n in one Nest TestingModule without a duplicate Nest core instance or an alias provider.

## Technical findings

- `nest start --watch` alone did not restart the server when shared output changed. `scripts/dev-server.mjs` runs the TypeScript watcher, then runs `dist/main.js` with Node watching the server `dist`, `packages/shared/dist` and both source locale directories; it stops both child processes on termination. The server dev process therefore consumes the built `@qiwu/shared` output, rebuilt by the shared `tsc -w`.
- Runtime paths resolve from the server working directory. Development and tests use source locales explicitly; builds copy the locale assets to dist, avoiding accidental use of stale build strings.
- Request IDs accept a bounded safe header or generate a UUID, shared by CLS, pino and error responses. Logs redact credentials and cookies.
- Endpoint tests listen once on an ephemeral loopback port, rather than asking supertest to open and close the server for each request.
- The `source` export condition resolves `@qiwu/shared` to its TypeScript sources in server Vitest, the server typecheck and the web Vite dev server. The server dev process and the production server consume its built output (`packages/shared/dist`).

## Consequences

Keep ESM and the explicit development runner. Dependency updates must preserve Nest dependency injection, metadata, locale loading and shared-change restarts. Use `pnpm --filter @qiwu/server test <full-spec-stem>` without an extra `--` to filter a server spec. Runtime checks use the bounded `pnpm smoke:boot`; the optional CJS probe is informational and does not promise compatibility with every dependency.

See the [layering design](../design-notes.md#layering) and [getting-started guide](../getting-started.md).
