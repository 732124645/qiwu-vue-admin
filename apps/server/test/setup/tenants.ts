// Tenants for specs (see docs/design-notes.md#tenancy). Server spec files run one after another, in no fixed
// order, on one test database reset once per run: a spec that writes rows of a tenant other than the
// default one takes it from createTenant (never a fixed id) and disposes of it in afterAll, before any
// resetDb or reseed, so no other file ever sees it. The setup file `tenant-leftovers.ts` fails a file that
// leaves a tenant behind.
// Specs that call services straight (no request around them, so no tenant in the context) wrap the call
// in inTenant1; they never set a context around the whole file (it would reach every request through
// `listen()` and hide a missing one).
// Specs with the multi-tenancy switch on boot their app with bootApp({ multiTenant: true }); the
// committed test env keeps it off.
// A tenant is opened as the product opens one (TenantProvisioner): its root dept, builtin `tenant_admin`
// role, process templates, leave model and administrator `owner` come with it, its process models under
// the default tenant's model keys (`leave` and the templates'); any other row a spec needs: `addRow`.
import { basename } from 'node:path'
import type { INestApplication, Type } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { DEFAULT_PASSWORD_POLICY } from '@qiwu/shared'
import bcrypt from 'bcryptjs'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { expect } from 'vitest'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { DEFAULT_TENANT_ID, withTenant } from '../../src/core/context/tenant.js'
import { insertRow, type Row } from '../../src/db/seeds/upsert.js'

/** Runs `fn` in the default tenant, as a request would. */
export const inTenant1 = <T>(fn: () => T): T => withTenant(DEFAULT_TENANT_ID, fn)

type Db = DataSource | INestApplication
const dataSource = (db: Db): DataSource =>
  'getHttpServer' in db ? db.get<DataSource>(getDataSourceToken()) : db

let seq = 0
/** `<prefix>-<spec file>-<n>`: unique within the run (a file's tenants are gone before the next file starts). */
function nextName(prefix: 't' | 'p'): string {
  const file = basename(expect.getState().testPath ?? 'spec').replace(/\.(e2e-)?spec\.ts$/, '')
  const stem = file
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 24)
    .replace(/-+$/, '')
  return `${prefix}-${stem}-${++seq}`
}

/** A tenant package of a spec (`createPackage`). */
export interface TestPackage {
  id: number
  name: string
  /** Deletes the package and its menus (plain SQL); tenants still naming it are the caller's to dispose of first. */
  dispose(): Promise<void>
}

export interface PackageOptions {
  /** the menus it opens; default: every live menu open to tenants (`platform_only = 0`) */
  menuIds?: number[]
  /** default true */
  enabled?: boolean
}

/**
 * A new tenant package (plain SQL, name `p-<spec file>-<n>`) with its menus. Dispose of it in afterAll, as
 * of a tenant: the setup file `tenant-leftovers.ts` fails a file that leaves a package behind.
 */
export async function createPackage(db: Db, opts: PackageOptions = {}): Promise<TestPackage> {
  const ds = dataSource(db)
  const name = nextName('p')
  const { insertId } = await ds.query<{ insertId: number }>(
    'INSERT INTO iam_tenant_package (name, enabled) VALUES (?, ?)',
    [name, opts.enabled === false ? 0 : 1],
  )
  const id = Number(insertId)
  const menuIds =
    opts.menuIds ??
    (
      await ds.query<{ id: number }[]>(
        'SELECT id FROM iam_menu WHERE platform_only = 0 AND deleted_at IS NULL',
      )
    ).map((r) => Number(r.id))
  if (menuIds.length)
    await ds.query('INSERT INTO iam_tenant_package_menus (package_id, menu_id) VALUES ?', [
      menuIds.map((m) => [id, m]),
    ])
  return {
    id,
    name,
    dispose: async () => {
      await ds.query('DELETE FROM iam_tenant_package_menus WHERE package_id = ?', [id])
      await ds.query('DELETE FROM iam_tenant_package WHERE id = ?', [id])
    },
  }
}

/** Password of the users `addUser` and `createTenant({ users: true })` make (counts as changed). */
export const TENANT_PASSWORD = 'Tenant#2026-test'
/** The mobile of the other tenant's `alice`: give a default-tenant user the same one to make twins. */
export const TWIN_MOBILE = '13900009001'

/** Username of the administrator every tenant is opened with (`TestTenant.ownerId`). */
export const TENANT_OWNER = 'owner'

export interface TestTenant {
  id: number
  code: string
  /** its package (`TenantOptions.packageId`) */
  packageId: number | null
  /** its administrator `owner`: holds `tenant_admin`, sits in the root dept, must change its password */
  ownerId: number
  /** the tenant's initial password, the owner's current one */
  initialPassword: string
  /** Revokes the sessions of its users (an app's db), then deletes the tenant and every row it has. */
  dispose(): Promise<void>
}

/**
 * A tenant with people under the default tenant's names: a top-level dept `seed.dept.hq` (beside the
 * provisioned root dept), the role `member` (`seed.role.member`, own dept, no menus), the position
 * `developer` (`seed.position.developer`) and the users `admin` and `alice` in both dept and role
 * (`alice` with `TWIN_MOBILE`, holding the position), password `TENANT_PASSWORD`.
 */
export interface PeopledTenant extends TestTenant {
  deptId: number
  roleId: number
  positionId: number
  users: { admin: number; alice: number }
}

export interface TenantOptions {
  name?: string
  /** host names bound to the tenant (`iam_tenant_domain`) */
  domains?: string[]
  /** add its dept, role and users (`PeopledTenant`) */
  users?: boolean
  /**
   * its package: left out, a new one opening every menu open to tenants (`createPackage`, disposed of with
   * the tenant); null none (a tenant other than the default one without a package may use nothing)
   */
  packageId?: number | null
}

/**
 * A new enabled tenant (auto-increment id, code from the spec file's name), opened through
 * TenantProvisioner (an app's, else one over the data source with the default password policy), with its
 * package (by default its own one, opening every menu open to tenants), its host names and, asked for,
 * its people.
 */
export async function createTenant(
  db: Db,
  opts: TenantOptions & { users: true },
): Promise<PeopledTenant>
export async function createTenant(db: Db, opts?: TenantOptions): Promise<TestTenant>
export async function createTenant(
  db: Db,
  opts: TenantOptions = {},
): Promise<TestTenant | PeopledTenant> {
  const ds = dataSource(db)
  const code = nextName('t')
  const { id, adminId, initialPassword } = await (
    await provisioner(db)
  ).provision({
    code,
    name: opts.name ?? code,
    admin: { username: TENANT_OWNER, displayName: TENANT_OWNER },
  })
  let own: TestPackage | null = null
  // a step failing after the provision takes the half-made tenant with it
  try {
    own = opts.packageId === undefined ? await createPackage(db) : null
    const packageId = own?.id ?? opts.packageId ?? null
    await ds.query('UPDATE iam_tenant SET package_id = ? WHERE id = ?', [packageId, id])
    const tenant: TestTenant = {
      id,
      code,
      packageId,
      ownerId: adminId,
      initialPassword,
      dispose: async () => {
        await removeTenant(db, id)
        await own?.dispose()
      },
    }
    for (const domain of opts.domains ?? [])
      await ds.query('INSERT INTO iam_tenant_domain (tenant_id, domain) VALUES (?, ?)', [
        id,
        domain,
      ])
    if (!opts.users) return tenant
    const { insertId: deptId } = await ds.query<{ insertId: number }>(
      "INSERT INTO iam_dept (parent_id, tree_path, name, tenant_id) VALUES (0, '/', 'seed.dept.hq', ?)",
      [id],
    )
    await ds.query('UPDATE iam_dept SET tree_path = ? WHERE id = ?', [`/${deptId}/`, deptId])
    const { insertId: roleId } = await ds.query<{ insertId: number }>(
      "INSERT INTO iam_role (code, name, data_scope, tenant_id) VALUES ('member', 'seed.role.member', 'own_dept', ?)",
      [id],
    )
    const people = { deptId: Number(deptId), roleId: Number(roleId) }
    const user = (username: string, mobile: string | null) =>
      addUser(db, id, username, { ...people, mobile })
    const users = { admin: await user('admin', null), alice: await user('alice', TWIN_MOBILE) }
    const positionId = await addRow(db, id, 'iam_position', {
      code: 'developer',
      name: 'seed.position.developer',
    })
    await addRow(db, id, 'iam_user_positions', { user_id: users.alice, position_id: positionId })
    return { ...tenant, ...people, positionId, users }
  } catch (e) {
    await removeTenant(db, id)
    await own?.dispose()
    throw e
  }
}

/**
 * A row of tenant table `table` in tenant `tenantId` (plain SQL, `tenant_id` written explicitly; columns
 * by name, plain objects to json): what a spec gives the other tenant beyond `PeopledTenant`, e.g. a
 * book under an ISBN the default tenant uses too. Returns its id (0 for a table without one).
 */
export const addRow = (db: Db, tenantId: number, table: string, row: Row): Promise<number> =>
  insertRow(dataSource(db).manager, table, { ...row, tenant_id: tenantId })

/** The app's TenantProvisioner; for a bare data source one with the env's APP_SECRET and the default policy. */
async function provisioner(db: Db) {
  const { TenantProvisioner } =
    await import('../../src/modules/platform/iam/tenant/tenant-provisioner.js')
  if ('getHttpServer' in db) return db.get(TenantProvisioner, { strict: false })
  const { SecretBox } = await import('../../src/core/crypto/secret-box.js')
  const box = new SecretBox({ get: (key: string) => process.env[key] } as never)
  return new TenantProvisioner(dataSource(db), box, {
    load: async () => ({ policy: DEFAULT_PASSWORD_POLICY }),
  } as never)
}

/**
 * An enabled user of tenant `tenantId` (plain SQL: its tenant is explicit) with password
 * `TENANT_PASSWORD`, counted as changed; in `deptId` and holding `roleId` when given. Returns its id.
 */
export async function addUser(
  db: Db,
  tenantId: number,
  username: string,
  opts: { deptId?: number; roleId?: number; mobile?: string | null } = {},
): Promise<number> {
  const ds = dataSource(db)
  const { insertId } = await ds.query<{ insertId: number }>(
    `INSERT INTO iam_user (username, password_hash, display_name, dept_id, mobile, password_changed_at, tenant_id)
     VALUES (?, ?, ?, ?, ?, NOW(3), ?)`,
    [
      username,
      bcrypt.hashSync(TENANT_PASSWORD, 4),
      username,
      opts.deptId ?? null,
      opts.mobile ?? null,
      tenantId,
    ],
  )
  const userId = Number(insertId)
  if (opts.roleId !== undefined)
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id, tenant_id) VALUES (?, ?, ?)', [
      userId,
      opts.roleId,
      tenantId,
    ])
  return userId
}

/** `dispose` of a tenant a spec did not create with createTenant (one opened through the API or a seed). */
export const disposeTenant = (db: Db, id: number): Promise<void> => removeTenant(db, id)

/**
 * The sessions of the tenant's users first (with an app at hand: SessionRevoker.revokeUser, so no
 * session outlives its rows), then in plain SQL, no ORM (so no tenant context needed): the rows of
 * tenant `id` in every table with a `tenant_id` column (the tenant tables, fixtures included, and the
 * platform tables referring to a tenant), then the tenant row. Tenants are never deleted in the product;
 * only specs clean up so.
 */
async function removeTenant(db: Db, id: number): Promise<void> {
  if (id === DEFAULT_TENANT_ID) throw new Error('the default tenant is never disposed of')
  const ds = dataSource(db)
  if ('getHttpServer' in db) {
    const { SessionRevoker } = await import('../../src/core/auth/session-revoker.js')
    const users = await ds.query<{ id: number }[]>('SELECT id FROM iam_user WHERE tenant_id = ?', [
      id,
    ])
    for (const u of users)
      await db.get(SessionRevoker, { strict: false }).revokeUser(Number(u.id), 'user_unavailable')
  }
  const tables = await ds.query<{ name: string }[]>(
    `SELECT c.TABLE_NAME AS name FROM information_schema.COLUMNS c
       JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
      WHERE c.TABLE_SCHEMA = DATABASE() AND c.COLUMN_NAME = 'tenant_id' AND t.TABLE_TYPE = 'BASE TABLE'`,
  )
  for (const { name } of tables) await ds.query(`DELETE FROM \`${name}\` WHERE tenant_id = ?`, [id])
  await ds.query('DELETE FROM iam_tenant WHERE id = ?', [id])
}

/**
 * A session for user `userId` minted straight through the identity load and TokenService (no sign-in
 * request, no tenant resolution): null when the load refuses the user or the issue is refused.
 */
export async function signInDirect(
  app: INestApplication,
  userId: number,
  opts: { keepSignedIn?: boolean; clientId?: string } = {},
) {
  const { PermVersion } = await import('../../src/core/auth/perm-version.js')
  const { TokenService } = await import('../../src/core/auth/token.service.js')
  const user = await app.get(PermVersion).load(userId)
  if (!user) return null
  return app
    .get(TokenService)
    .issue(user, { keepSignedIn: false, ip: '127.0.0.1', ua: 'vitest', ...opts })
}

/** POST /api/auth/login with a tenant code (optional) and, `host` given, that Host header. */
export function loginAs(
  app: INestApplication,
  body: { username: string; password: string; tenantCode?: string },
  host?: string,
) {
  const req = request(app.getHttpServer()).post('/api/auth/login')
  return (host ? req.set('Host', host) : req).send(body)
}

/**
 * The whole app (AppModule, setupApp, listening on a free port) with `APP_MULTI_TENANT` as asked and
 * `env` on top of the process env, read into its own config (the process env is left alone). Close it
 * in afterAll.
 */
export async function bootApp(opts: {
  multiTenant: boolean
  env?: Record<string, string>
  controllers?: Type[]
}): Promise<NestExpressApplication> {
  const { AppModule } = await import('../../src/app.module.js')
  const { setupApp } = await import('../../src/app.setup.js')
  const env = { ...process.env, ...opts.env, APP_MULTI_TENANT: String(opts.multiTenant) }
  const mod = await Test.createTestingModule({
    imports: [AppModule],
    controllers: opts.controllers ?? [],
  })
    // AppModule's ConfigModule.forRoot is evaluated at import time: each app gets its own parsed env
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(EnvSchema.parse(env)))
    .compile()
  const app = setupApp(mod.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  return app
}
