# ADR-001 — Server module format: ESM

- Status: accepted
- Date: 2026-09-26

## Context and decision

Use ESM for the NestJS 12 server: `"type": "module"`, TypeScript `module: nodenext`, and `.js` suffixes on relative imports. Build decorated server code with TypeScript before running it; do not use tsx or Node type stripping because they do not provide the required decorator metadata.

Node 22 loads the selected CommonJS dependencies through its ESM interoperability. The integration checks exercised CLS transactions, TypeORM, logging, throttling and i18n in one Nest TestingModule without a duplicate Nest core instance or an alias provider.

## Technical findings

- `nest start --watch` alone did not restart the server when shared output changed. `scripts/dev-server.mjs` now owns the shared TypeScript watcher and runs the existing server incremental compiler after shared compilation succeeds. The shared helper reports actual compiler inputs and completion over IPC; the parent checks the current inputs before allowing a server build or application replacement. Source events are summarized, duplicate events with identical contents are ignored, and compilation errors leave the still-running application in place. The server consumes built `@qiwu/shared` output; root `pnpm dev` starts this runner and Vite without a second shared watcher.
- Development readiness is reported by the application after `listen`, over the child-process IPC channel. Compile completion and actual application readiness are measured separately, and subsequent successful reloads are compared with each other. Repeated framework startup messages are suppressed only in the development runner; warnings, errors and production logs remain available.
- A bounded `pnpm smoke:boot --dev-reload` check exercises the real application with test MySQL/Redis, real file events and temporary source probes. It verifies shared body changes with unchanged declarations, server changes, compile failures, process identity and recovery, then stops all processes and restores source and build output. The complete local gate runs it after the ordinary boot check.
- Runtime paths resolve from the server working directory. Development and tests use source locales explicitly; builds copy the locale assets to dist, avoiding accidental use of stale build strings.
- Request IDs accept a bounded safe header or generate a UUID, shared by CLS, pino and error responses. Logs redact credentials and cookies.
- Endpoint tests listen once on an ephemeral loopback port, rather than asking supertest to open and close the server for each request.
- The `source` export condition resolves `@qiwu/shared` to its TypeScript sources in server Vitest, the server typecheck and the web Vite dev server. The server dev process and the production server consume its built output (`packages/shared/dist`).

## Consequences

Keep ESM and the explicit development runner. Dependency updates must preserve Nest dependency injection, metadata, locale loading and shared-change restarts. Use `pnpm --filter @qiwu/server test <full-spec-stem>` without an extra `--` to filter a server spec. Runtime checks use the bounded `pnpm smoke:boot`; the optional CJS probe is informational and does not promise compatibility with every dependency. Server source stays free of `import.meta` (paths come from `src/core/paths.ts`) and of top-level await, so a CommonJS fallback build needs no source changes; the arch check `cjs-safe` enforces it.

See the [layering design](../design-notes.md#layering) and [getting-started guide](../getting-started.md).
