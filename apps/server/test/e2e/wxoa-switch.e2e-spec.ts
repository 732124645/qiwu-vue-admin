// The Official Account module behind its start-up switch (see docs/design-notes.md#wxoa), here off
// (`APP_WXOA=false`; the test env has it on, so every other wxoa spec runs with the module): the module is
// not loaded, so every /api/wxoa route answers 404, the callback of a live account too; no handler of its
// jobs is registered and an enabled task of theirs is not scheduled; its gateway does not exist, so
// nothing goes to WeChat; the side menu, the role grant tree and the tenant package tree leave the group out (a grant on it
// survives a grant edit) while the menu management still lists it; the demo seed makes no sample
// account. With the switch on (the other specs, wxoa-perms.e2e) all of it is there.
import https from 'node:https'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import type { MenuNode, RoleMenuNode } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { SecretBox } from '../../src/core/crypto/secret-box.js'
import { findId, insertRow } from '../../src/db/seeds/upsert.js'
import { seedWxoaDemo, WXOA_DEMO_APP_ID } from '../../src/db/seeds/wxoa/wxoa-demo.seed.js'
import { TenantPackageService } from '../../src/modules/platform/iam/tenant-package/tenant-package.service.js'
import { JobRegistry } from '../../src/modules/platform/scheduler/job-registry.js'
import { JobScheduler } from '../../src/modules/platform/scheduler/job-scheduler.js'
import { WxoaGateway } from '../../src/modules/platform/wxoa/core/wxoa-gateway.js'
import { bearer, signIn } from '../setup/auth.js'
import { inTenant1 } from '../setup/tenants.js'

// before AppModule is imported: the module list reads the switch when the app module loads
vi.hoisted(() => {
  process.env.APP_WXOA = 'false'
})

const KEY = 'wxoaswitchoffkey000001'
const PREFIX = 'e2e-wxoa-switch-'

let app: NestExpressApplication
let ds: DataSource
let root: string
let accountId = 0
let roleId = 0

const http = () => request(app.getHttpServer())
const ids = (nodes: { id: number; children: { id: number }[] }[]): number[] =>
  nodes.flatMap((n) => [n.id, ...ids(n.children as typeof nodes)])
/** The live wxoa menus: the group, its pages and their actions. */
const wxoaMenus = async (): Promise<number[]> =>
  (
    await ds.query<{ id: number }[]>(
      `SELECT id FROM iam_menu WHERE deleted_at IS NULL
          AND (route_name = 'wxoa' OR route_name LIKE 'wxoa-%' OR perms LIKE 'wxoa.%') ORDER BY id`,
    )
  ).map((r) => Number(r.id))

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.init()
  ds = app.get<DataSource>(getDataSourceToken())
  root = (await signIn(app)).accessToken
  accountId = await inTenant1(() =>
    insertRow(ds.manager, 'wxoa_account', {
      label: `${PREFIX}account`,
      app_id: 'wx00000000005w1tc0',
      account_kind: 'sandbox',
      crypto_mode: 'plain',
      app_secret_enc: app.get(SecretBox).encrypt('0'.repeat(32)),
      push_token_enc: app.get(SecretBox).encrypt('switchtoken'),
      callback_key: KEY,
    }),
  )
  roleId = await inTenant1(() =>
    insertRow(ds.manager, 'iam_role', {
      code: `${PREFIX}role`,
      name: `${PREFIX}role`,
      data_scope: 'all',
    }),
  )
})

afterAll(async () => {
  if (ds) {
    await ds.query('DELETE FROM wxoa_account WHERE id = ?', [accountId])
    await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [roleId])
    await ds.query('DELETE FROM iam_role WHERE id = ?', [roleId])
  }
  await app?.close()
})

it('every /api/wxoa route is 404, the callback of a live account too; nothing goes to WeChat', async () => {
  const outbound = vi.spyOn(https, 'request')
  try {
    for (const [method, path] of [
      ['get', '/api/wxoa/accounts'],
      ['get', '/api/wxoa/accounts/options'],
      ['post', '/api/wxoa/accounts'],
      ['get', `/api/wxoa/accounts/${accountId}`],
      ['post', `/api/wxoa/accounts/${accountId}/test`],
      ['get', `/api/wxoa/fans?accountId=${accountId}`],
      ['post', '/api/wxoa/fans/sync'],
      ['get', `/api/wxoa/messages?accountId=${accountId}`],
      ['get', `/api/wxoa/drafts?accountId=${accountId}`],
      ['get', `/api/wxoa/comments?accountId=${accountId}`],
    ] as const)
      await http()[method](path).set(bearer(root)).send({ accountId }).expect(404)
    const signed = { signature: 'x', timestamp: '1', nonce: 'n', echostr: 'e' }
    await http().get(`/api/wxoa/callback/${KEY}`).query(signed).expect(404)
    await http()
      .post(`/api/wxoa/callback/${KEY}`)
      .query(signed)
      .set('Content-Type', 'text/xml')
      .send('<xml><MsgType><![CDATA[text]]></MsgType></xml>')
      .expect(404)
    expect(outbound).not.toHaveBeenCalled()
  } finally {
    outbound.mockRestore()
  }
  expect(() => app.get(WxoaGateway, { strict: false })).toThrow()
})

it('no handler of its jobs is registered; an enabled task of theirs is not scheduled', async () => {
  const jobs = app.get(JobRegistry)
  expect(jobs.get('wxoa.fan.sync')).toBeUndefined()
  expect(jobs.get('wxoa.message.purge')).toBeUndefined()
  expect(jobs.list().filter((h) => h.name.startsWith('wxoa.'))).toEqual([])
  expect(jobs.get('audit.purge')).toBeDefined()
  const scheduler = app.get(JobScheduler)
  const tasks = await ds.query<{ id: number; enabled: number }[]>(
    "SELECT id, enabled FROM job_task WHERE handler LIKE 'wxoa.%' AND deleted_at IS NULL",
  )
  expect(tasks).toHaveLength(2)
  await ds.query('UPDATE job_task SET enabled = 1 WHERE id IN (?)', [tasks.map((t) => t.id)])
  try {
    for (const { id } of tasks) {
      await scheduler.sync(Number(id))
      expect(scheduler.isScheduled(Number(id))).toBe(false)
    }
  } finally {
    for (const { id, enabled } of tasks)
      await ds.query('UPDATE job_task SET enabled = ? WHERE id = ?', [enabled, id])
  }
})

it('the side menu and the grant tree leave the group out; a grant on it survives an edit; the menu management lists it', async () => {
  const menus = await wxoaMenus()
  const group = await inTenant1(() => findId(ds.manager, 'iam_menu', { route_name: 'wxoa' }))
  expect(menus).toContain(group)
  const side = ids((await http().get('/api/auth/menus').set(bearer(root)).expect(200)).body.data)
  expect(side.filter((id) => menus.includes(id))).toEqual([])
  const tree = ids(
    (await http().get('/api/iam/roles/menu-tree').set(bearer(root)).expect(200)).body
      .data as RoleMenuNode[],
  )
  expect(tree.filter((id) => menus.includes(id))).toEqual([])
  expect(tree.length).toBeGreaterThan(0)
  // the tenant package grant tree too (its pages need multi-tenancy, so read through the service)
  const packageTree = ids(await inTenant1(() => app.get(TenantPackageService).menuTree()))
  expect(packageTree.filter((id) => menus.includes(id))).toEqual([])
  expect(packageTree.length).toBeGreaterThan(0)
  // the management page lists every menu, the group with its pages
  const listed = ids((await http().get('/api/iam/menus').set(bearer(root)).expect(200)).body.data)
  expect(menus.filter((id) => !listed.includes(id))).toEqual([])

  // a grant on a hidden menu stays when the role's grants are edited (as on the tenant pages)
  const page = await inTenant1(() => findId(ds.manager, 'iam_menu', { route_name: 'wxoa-account' }))
  await ds.query('INSERT INTO iam_role_menus (tenant_id, role_id, menu_id) VALUES (1, ?, ?)', [
    roleId,
    page,
  ])
  const visible = tree.find((id) => !menus.includes(id))!
  await http()
    .put(`/api/iam/roles/${roleId}/menus`)
    .set(bearer(root))
    .send({ menuLink: false, menuIds: [visible] })
    .expect(200)
  const kept = await ds.query<{ menu_id: number }[]>(
    'SELECT menu_id FROM iam_role_menus WHERE role_id = ? AND deleted_at IS NULL ORDER BY menu_id',
    [roleId],
  )
  expect(kept.map((r) => Number(r.menu_id)).sort()).toEqual([page, visible].sort())
  const sideAgain = (await http().get('/api/auth/menus').set(bearer(root)).expect(200)).body
    .data as MenuNode[]
  expect(sideAgain.some((n) => n.routeName === 'wxoa')).toBe(false)
})

it('the demo seed makes no sample account', async () => {
  const before = process.env.APP_DEMO_MODE
  process.env.APP_DEMO_MODE = 'true'
  try {
    expect(await inTenant1(() => seedWxoaDemo(ds.manager))).toEqual([])
  } finally {
    if (before === undefined) delete process.env.APP_DEMO_MODE
    else process.env.APP_DEMO_MODE = before
  }
  expect(
    await ds.query('SELECT id FROM wxoa_account WHERE app_id = ?', [WXOA_DEMO_APP_ID]),
  ).toEqual([])
})
