// Shared by playwright.config.ts, the global setup and the fixtures: e2e server env and test users.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

export const serverDir = fileURLToPath(new URL('../../server/', import.meta.url))

const envFile = (dir: string, name: string) =>
  existsSync(join(dir, name)) ? parseEnv(readFileSync(join(dir, name), 'utf8')) : {}

/**
 * Server env: git-ignored `.env.local` credentials, the committed `.env.e2e` mode file, then the
 * optional git-ignored `.env.e2e.local` (a parallel checkout's own DB_NAME, REDIS_DB, PORT and E2E_WEB_PORT, so
 * two Playwright runs can share the machine). The server command drops and reseeds DB_NAME and the
 * global setup clears REDIS_DB: a DB_NAME without the `_e2e` suffix stops the run.
 */
export function e2eServerEnv(dir = serverDir): Record<string, string> {
  const env: Record<string, string> = {
    ...envFile(dir, '.env.local'),
    ...envFile(dir, '.env.e2e'),
    ...envFile(dir, '.env.e2e.local'),
    ENV_FILE: '.env.e2e',
  }
  if (!env.DB_NAME?.endsWith('_e2e'))
    throw new Error(`e2e refused: DB_NAME must end in _e2e (got '${env.DB_NAME ?? ''}')`)
  return env
}

export const serverEnv = e2eServerEnv()

// Test-only accounts in the throwaway e2e database (not credentials).
const E2E_PASSWORD = 'E2e-Pass@2026'
export const USERS = {
  /** seeded root `admin`, password from `.env.e2e` SEED_ADMIN_PASSWORD */
  admin: { username: 'admin', password: serverEnv.SEED_ADMIN_PASSWORD ?? '' },
  /** role `demo`: home page only, no `settings.dict.browse` */
  limited: { username: 'e2e_limited', password: E2E_PASSWORD },
  /** role `demo` with `password_changed_at = NULL`: forced to change the password first */
  fresh: { username: 'e2e_fresh', password: E2E_PASSWORD },
  /** like `fresh`, for the spec that really changes the password (login.spec) */
  changer: { username: 'e2e_changer', password: E2E_PASSWORD },
  /** role `demo` plus role `e2e_reader`, granted only `iam.position.browse` + `iam.user.browse` (perm.spec) */
  reader: { username: 'e2e_reader', password: E2E_PASSWORD },
  /** role `demo` plus role `e2e_modifier`: `iam.position.browse` + `modify`, no `view` (perm.spec) */
  modifier: { username: 'e2e_modifier', password: E2E_PASSWORD },
  /** role `demo` plus role `e2e_tree`: `iam.user.browse` over its dept and below (org.spec moves it) */
  tree: { username: 'e2e_tree', password: E2E_PASSWORD },
  /** role `demo` plus role `e2e_scoped`: `iam.user.browse`, scope `all` until org.spec's data-scope dialog narrows it */
  scoped: { username: 'e2e_scoped', password: E2E_PASSWORD },
  /** role `demo` plus role `e2e_granter`: `iam.role.browse` + `grant`, not root (org.spec: no `all` scope offered) */
  granter: { username: 'e2e_granter', password: E2E_PASSWORD },
  /** role `demo`, dept support, position support: the personal center (profile.spec) */
  profile: { username: 'e2e_profile', password: E2E_PASSWORD },
  /** scheduler create/run/remove actions for the cross-user inbox push */
  operator: { username: 'e2e_operator', password: E2E_PASSWORD },
  /** role `demo` plus role `e2e_rt`: the realtime demo page only, no send (realtime-demo.spec receives) */
  rt: { username: 'e2e_rt', password: E2E_PASSWORD },
  /** the seeded role `staff` alone (own rows, like the OA users), dept support: the approval center (wf-center-* specs) */
  staff: { username: 'e2e_staff', password: E2E_PASSWORD },
  /** role `demo` plus role `e2e_wf_ops`: wf instance + task browse over its dept, no view / manage (wf-admin.spec) */
  wfAdmin: { username: 'e2e_wf_ops', password: E2E_PASSWORD },
  /** role `demo` plus role `e2e_wf_viewer`: wf instance browse + view over its dept, no approval center (wf-admin.spec) */
  wfViewer: { username: 'e2e_wf_viewer', password: E2E_PASSWORD },
  // the seeded OA demo users of process `leave` (role staff): the seed gives them a random
  // password, the global setup this one, counted as changed
  oaEmployee: { username: 'oa.employee', password: E2E_PASSWORD },
  oaSupervisor: { username: 'oa.supervisor', password: E2E_PASSWORD },
  oaDeputy: { username: 'oa.deputy', password: E2E_PASSWORD },
  oaDirector: { username: 'oa.director', password: E2E_PASSWORD },
  oaHr: { username: 'oa.hr', password: E2E_PASSWORD },
} as const
/** the seeded OA demo users (global setup sets their password) */
export const OA_USERS = ['oaEmployee', 'oaSupervisor', 'oaDeputy', 'oaDirector', 'oaHr'] as const
export type E2eUser = keyof typeof USERS
