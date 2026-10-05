import { resolve } from 'node:path'

// Every runtime path resolves from process.cwd() (= apps/server for `node dist/main.js`, `nest start`,
// smoke:boot, db scripts and Vitest), never from import.meta/__dirname, so the same source runs as
// ESM or CJS (see docs/adr/001-module-format.md). Overrides are env config, not code branches. Read lazily: env may load after import.

const fromCwd = (path: string): string => resolve(process.cwd(), path)

/**
 * Env files, highest precedence first (the process env beats both): the mode file
 * (`ENV_FILE`: `.env` in dev, `.env.test` for Vitest/smoke:boot, `.env.e2e` for Playwright), then
 * the git-ignored `.env.local`, which only supplies credentials.
 */
export const envFiles = (): string[] => [process.env.ENV_FILE ?? '.env', '.env.local'].map(fromCwd)

/**
 * Backend locale dirs. Built: `dist/i18n`, where nest-cli assets copy src/i18n and the shared
 * validation/field JSON. From source (`I18N_DIR=src/i18n`, set by Vitest and the dev runner): that dir
 * plus `packages/shared/src/i18n` as a second source.
 */
export const i18nDirs = (): string[] =>
  process.env.I18N_DIR
    ? [fromCwd(process.env.I18N_DIR), fromCwd('../../packages/shared/src/i18n')]
    : [fromCwd('dist/i18n')]

/** Compiled TypeORM migrations: always run from dist, never through tsx (see docs/adr/002-orm.md, docs/adr/001-module-format.md). */
export const migrationsGlob = (): string => fromCwd('dist/db/migrations/*.js')

export const DEFAULT_UPLOAD_ROOT = './data/upload'

/** Local file storage root (`STORAGE_LOCAL_ROOT`; see docs/design-notes.md#storage). */
export const uploadRoot = (): string =>
  fromCwd(process.env.STORAGE_LOCAL_ROOT ?? DEFAULT_UPLOAD_ROOT)

/**
 * ip2region IPv4 data: not in git, `node scripts/fetch-ip2region.mjs` downloads it here
 * (sha256-checked); missing → IP locations stay empty.
 */
export const ip2regionFile = (): string => fromCwd('data/ip2region_v4.xdb')

/**
 * Code generator templates (`codegen-templates/`; see docs/design-notes.md#layering): the build copies them to
 * `dist/codegen-templates`; from source (`CODEGEN_TEMPLATES=codegen-templates`, Vitest) the originals.
 */
export const codegenTemplatesDir = (): string =>
  fromCwd(process.env.CODEGEN_TEMPLATES ?? 'dist/codegen-templates')
