# ADR-006 — Runtime and package manager

- Status: accepted
- Decision date: 2026-10-03
- Patch selection updated: 2026-10-04

## Decision

Use **Node 22 and pnpm 11.28.x for v1.0**, with maintained patches. `.nvmrc` selects Node 22; both projects require Node `>=22.22.1` and pin **pnpm 11.28.3** in `packageManager`. Keep Node 22 types and TypeScript `~6.0`.

## Reasons

According to the official sources consulted on 2026-10-03, Node 22 Maintenance LTS and pnpm 11 security support both end on **2027-04-30**, which sets the migration target date.

The selected toolchain supports the repository's ESM server, decorator metadata, frontend build, independent mobile project and native Windows PowerShell 5.1 commands. pnpm 11.28.3 includes installer security fixes while preserving the existing lockfile format, explicit `allowBuilds`, strict release-age policy and form-create dependency hook.

Node 24 and pnpm 12 can be evaluated independently. The engines range permits newer Node versions, but does not establish compatibility with every major or patch; pnpm 12 has not been qualified for this repository. A clean application dependency audit does not by itself verify the package-manager binary.

## Re-evaluation triggers

- **2027-01-30:** begin qualification of the next runtime and package-manager majors, targeting completion before **2027-04-30**. Refresh the [Node release schedule](https://github.com/nodejs/Release/blob/main/schedule.json) and [pnpm security policy](https://github.com/pnpm/pnpm/security/policy) to confirm the applicable support windows.
- Re-evaluate immediately if a security advisory, earlier support deadline or required dependency/API cannot be addressed on the current majors. Prefer a maintained patch when it resolves the issue.
- Before a major upgrade, check root and mobile frozen installs, approval maps, release-age settings, dependency hooks, builds, `pnpm verify`, `pnpm ci:local` and native Windows PowerShell 5.1 operation. Synchronize both pins, runtime constraints, types and setup/deployment documentation.
