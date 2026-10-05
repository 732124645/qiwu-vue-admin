// Mobile Playwright env: the built server of apps/server in its e2e mode, moved to its own
// database, Redis db and ports so it runs beside the web Playwright (qiwu_e2e / Redis 14 / 3200 / 4173);
// a parallel checkout moves it once more with apps/server/.env.mobile-e2e.local. The specs' shared
// helpers below.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { expect, type APIRequestContext, type Page } from '@playwright/test'

export const serverDir = resolve(__dirname, '../../apps/server')

const envFile = (name: string) => {
  const file = join(serverDir, name)
  return existsSync(file) ? (parseEnv(readFileSync(file, 'utf8')) as Record<string, string>) : {}
}

/**
 * A parallel checkout's own database (`*_e2e`: the reset refuses others), Redis db, ports and upload folder,
 * from the git-ignored `.env.mobile-e2e.local`, layered last; unknown keys fail (a misspelt port would
 * silently collide with the main tree's run).
 */
const LOCAL_KEYS = ['DB_NAME', 'REDIS_DB', 'PORT', 'STORAGE_LOCAL_ROOT', 'E2E_H5_PORT']
const local = envFile('.env.mobile-e2e.local')
for (const key of Object.keys(local))
  if (!LOCAL_KEYS.includes(key))
    throw new Error(`.env.mobile-e2e.local: unknown key ${key} (allowed: ${LOCAL_KEYS.join(', ')})`)
if (local.DB_NAME !== undefined && !local.DB_NAME.endsWith('_e2e'))
  throw new Error(`.env.mobile-e2e.local: DB_NAME must end in _e2e (got '${local.DB_NAME}')`)
const { E2E_H5_PORT, ...localServer } = local

export const H5_PORT = Number(E2E_H5_PORT ?? 4175)

/**
 * The git-ignored `.env.local` credentials and the committed `.env.e2e` mode file, then the mobile run's
 * own database (dropped and reseeded on every run), Redis db, port and upload folder.
 */
export const serverEnv: Record<string, string> = {
  ...envFile('.env.local'),
  ...envFile('.env.e2e'),
  ENV_FILE: '.env.e2e',
  DB_NAME: 'qiwu_mobile_e2e',
  REDIS_DB: '9',
  PORT: '3201',
  STORAGE_LOCAL_ROOT: './data/mobile-e2e-upload',
  ...localServer,
}

// Test-only accounts in the throwaway e2e database (not credentials).
export const USERS = {
  /** seeded root `admin`, password from `.env.e2e` SEED_ADMIN_PASSWORD */
  admin: { username: 'admin', password: serverEnv.SEED_ADMIN_PASSWORD ?? '' },
  /** role `demo` with a mobile number (global setup), for SMS sign-in; codes go to a `debug` SMS channel */
  sms: { username: 'm_sms', password: 'E2e-Pass@2026', mobile: '13800995001' },
}

/**
 * Runs an ES module `script` with Node in apps/server (its dist and node_modules) and the server's env plus
 * `env`: what the tests need from Redis and MySQL directly. Resolves to its stdout.
 */
export function serverScript(script: string, env: Record<string, string> = {}): string {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: serverDir,
    env: { ...process.env, ...serverEnv, ...env },
    encoding: 'utf8',
  })
  if (r.status !== 0)
    throw new Error(`server script failed (${r.status ?? r.signal}):\n${r.stderr}`)
  return r.stdout
}

let client = 0
/**
 * A made-up client IP (TEST-NET-2), honoured from the loopback preview proxy (TRUST_PROXY=loopback): a test
 * that sends it (`page.setExtraHTTPHeaders({ 'X-Forwarded-For': clientIp() })`) signs in outside the suite's
 * shared per-IP limit (20 sign-ins a minute).
 */
export const clientIp = () => `198.51.100.${(client++ % 250) + 1}`

export const HOME = /#\/pages\/home\/index$/

export type User = { username: string; password: string }
export type Headers = Record<string, string>

/**
 * A console session of its own through the API (the duplicate-submit guard keys on the session), signed in
 * from a made-up client IP of its own (outside the suite's shared per-IP sign-in limit).
 */
export async function bearer(request: APIRequestContext, user: User): Promise<Headers> {
  const res = await request.post('/api/auth/login', {
    data: user,
    headers: { 'X-Forwarded-For': clientIp() },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return { Authorization: `Bearer ${(await res.json()).data.accessToken}` }
}

/** An API answer's `data`, failing the test on an error status. */
export async function data<T>(res: ReturnType<APIRequestContext['get']>): Promise<T> {
  const r = await res
  expect(r.ok(), await r.text()).toBe(true)
  return ((await r.json()) as { data: T }).data
}

/** Signs in on the sign-in page with a password and lands on the workbench. */
export async function signIn(page: Page, user: User) {
  await page.locator('.qw-login__username input').fill(user.username)
  await page.locator('.qw-login__password input').fill(user.password)
  await page.locator('uni-button', { hasText: /^(登录|Sign in)$/ }).click()
  await expect(page).toHaveURL(HOME)
}

export const tab = (page: Page, title: string) =>
  page.locator('.qw-tabbar .wd-tabbar-item', { hasText: title })
export const badge = (page: Page, title: string) => tab(page, title).locator('.qw-badge')
// a page's title: `expect(page).toHaveTitle()` (uni keeps the document title on the navigation bar's, also on
// the custom-navigation tab pages, which set it without showing a bar)
