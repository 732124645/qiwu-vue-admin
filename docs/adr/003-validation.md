# ADR-003 — Validation: shared Zod and Nest Standard Schema

- Status: accepted
- Date: 2026-09-26

## Context and decision

Use Zod 4 schemas in `@qiwu/shared` with Nest 12 Standard Schema validation. The same schema supplies server validation, Swagger descriptions, TypeScript types and Element Plus form rules. Validation errors are translation keys with parameters, so both applications can display the same field-level messages.

The integration checks covered coercion and sort whitelists, translated HTTP 400 responses with trace IDs, Swagger schemas and a mounted form that changes language. Invalid pagination, duplicate query values and unknown sort fields were rejected; valid input was transformed and unknown object fields stripped.

## Technical findings

- Configure Zod's global error map when importing shared schemas. Nest's Standard Schema path does not use a per-parse Zod error-map option; startup errors must therefore translate keys or show a field path with the key.
- Field domains use a custom Zod registry rather than `.meta()`, so internal label metadata does not leak into OpenAPI. Derived schemas do not inherit registry entries and must register their domain too.
- Field labels fall back from `field.<domain>.<prop>` to `field.common.<prop>`, then a generic input label or the raw path. Messages and labels exist in both shared locales.
- Vitest must inline Element Plus for form tests. Native loading can resolve async-validator to its CommonJS export object and make invalid form validation appear successful; the browser build uses the ESM path.
- Shared validation and field JSON files are loaded alongside server locales in source mode and copied into dist during builds. The server must not add its own files with these namespace names.
- Swagger reads the schema's input JSON Schema; `.meta({ id })` names a reusable component. A string sort parameter still needs its whitelist enforced by the shared schema.

## Consequences

List endpoints use `pageQuery([...sortable])`; schemas register a domain and use `validation.*` messages. The web uses `zodRules` and shared form messages. Cross-field rules require whole-model validation in addition to individual field rules, and the server remains authoritative.

See [validation design](../design-notes.md#validation), [internationalization](../i18n.md) and [CRUD conventions](../codegen-golden.md).
