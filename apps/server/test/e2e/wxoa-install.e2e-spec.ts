// WeChat Official Account install (see docs/design-notes.md#wxoa): on a fresh database and on one from
// before the module (its tables and seed rows absent), migrate → seed gives the top-level group with its
// pages and one action per permission, the dicts, the params and the two tasks; seeding again changes
// nothing. Going back reverts the module's first migration together with every later one (newest
// first, the tenant migration among them) and runs them all again, then hardens the tenant columns. The app boots with the module: the gateway is replaceable by the test fixture, the
// inbound hub runs every handler, the media download checker is registered. Its tables are never
// offered to the code generator.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import {
  Err,
  type MenuNode,
  WXOA_ACCOUNT_KINDS,
  WXOA_BUTTON_KINDS,
  WXOA_CHANNELS,
  WXOA_CLIENT_PLATFORMS,
  WXOA_CRYPTO_MODES,
  WXOA_LEGACY_BUTTON_KINDS,
  WXOA_MATCH_MODES,
  WXOA_MEDIA_KINDS,
  WXOA_MEDIA_TAG,
  WXOA_MSG_KINDS,
  WXOA_QR_KINDS,
  WXOA_REPLY_KINDS,
  WXOA_REPLY_TRIGGERS,
  WXOA_RETENTION_DAYS_DEFAULT,
  WXOA_SEND_STATES,
  wxoaParams,
  wxoaPerms,
} from '@qiwu/shared'
import request from 'supertest'
import { DataSource, type MigrationInterface } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { BizError } from '../../src/core/http/biz-error.js'
import { dataSourceOptions } from '../../src/db/data-source.js'
import { WxoaAccounts20261006100000 } from '../../src/db/migrations/20261006100000-wxoa-accounts.js'
import { runSeeds } from '../../src/db/seeds/index.js'
import { StorageAccess } from '../../src/modules/platform/storage/storage-access.js'
import { WxoaGateway } from '../../src/modules/platform/wxoa/core/wxoa-gateway.js'
import {
  type WxoaInbound,
  WxoaInboundHub,
} from '../../src/modules/platform/wxoa/core/wxoa-inbound-hub.js'
import { bearer, signIn } from '../setup/auth.js'
import { fakeWxoaGateway } from '../fixtures/wxoa/fake-gateway.js'
import { SOURCE_MIGRATIONS } from '../setup/migrations.js'
import { restoreTestSchema } from '../setup/schema.js'

type Migration = new () => MigrationInterface
/** The module's first migration and every later one, oldest first (the tenant migration among them). */
const FIRST = SOURCE_MIGRATIONS.indexOf(WxoaAccounts20261006100000)
if (FIRST < 0) throw new Error('WxoaAccounts20261006100000 not found in src/db/migrations')
const MIGRATIONS: Migration[] = SOURCE_MIGRATIONS.slice(FIRST)

const PAGES = [
  'account',
  'chat',
  'message',
  'reply',
  'menu',
  'fan',
  'material',
  'template',
  'qrcode',
  'draft',
  'publish',
  'mass',
  'stat',
  'notice',
] as const

const DICT_VALUES: Record<string, readonly string[]> = {
  'wxoa.account_kind': WXOA_ACCOUNT_KINDS,
  'wxoa.button_kind': [...WXOA_BUTTON_KINDS, ...WXOA_LEGACY_BUTTON_KINDS],
  'wxoa.channel': WXOA_CHANNELS,
  'wxoa.client_platform': WXOA_CLIENT_PLATFORMS,
  'wxoa.crypto_mode': WXOA_CRYPTO_MODES,
  'wxoa.match_mode': WXOA_MATCH_MODES,
  'wxoa.media_kind': WXOA_MEDIA_KINDS,
  'wxoa.msg_kind': WXOA_MSG_KINDS,
  'wxoa.qr_kind': WXOA_QR_KINDS,
  'wxoa.reply_kind': WXOA_REPLY_KINDS,
  'wxoa.reply_trigger': WXOA_REPLY_TRIGGERS,
  'wxoa.send_state': WXOA_SEND_STATES,
  'wxoa.publish_state': ['publishing', 'succeeded', 'failed', 'removed'],
  'wxoa.mass_target': ['all', 'tag', 'openids'],
  'wxoa.mass_state': ['submitted', 'succeeded', 'failed', 'removed'],
}

const TABLES = [
  'wxoa_account',
  'wxoa_draft',
  'wxoa_fan',
  'wxoa_inline_image',
  'wxoa_mass_job',
  'wxoa_material',
  'wxoa_menu',
  'wxoa_message',
  'wxoa_publish',
  'wxoa_qrcode',
  'wxoa_reply_rule',
  'wxoa_tag',
]

const fake = fakeWxoaGateway()
let app: NestExpressApplication
let ds: DataSource
let admin: string

/** Every row the wxoa seed owns, in a stable order. */
const installed = async (q: DataSource) => ({
  menus: (await q.query(
    `SELECT m.id, m.kind, m.route_name, m.name, m.route_path, m.component, m.component_name, m.icon,
            m.sort_no, m.perms, m.keep_alive, p.route_name AS parent
       FROM iam_menu m LEFT JOIN iam_menu p ON p.id = m.parent_id
      WHERE m.deleted_at IS NULL AND (m.route_name = 'wxoa' OR m.route_name LIKE 'wxoa-%' OR m.perms LIKE 'wxoa.%')
      ORDER BY m.kind, m.route_name, m.perms`,
  )) as {
    id: number
    kind: string
    route_name: string | null
    component: string | null
    perms: string | null
    parent: string | null
  }[],
  dicts: await q.query(
    "SELECT id, code, name, name_i18n FROM cfg_dict WHERE code LIKE 'wxoa.%' AND deleted_at IS NULL ORDER BY code",
  ),
  entries: (await q.query(
    `SELECT id, dict_code, value, label, label_i18n, tag_type, sort_no, is_default FROM cfg_dict_entry
      WHERE dict_code LIKE 'wxoa.%' AND deleted_at IS NULL ORDER BY dict_code, sort_no`,
  )) as { dict_code: string; value: string }[],
  params: await q.query(
    `SELECT id, param_key, param_value, name, name_i18n, group_code, is_builtin, is_public FROM cfg_param
      WHERE param_key LIKE 'wxoa.%' AND deleted_at IS NULL ORDER BY param_key`,
  ),
  tasks: await q.query(
    `SELECT id, handler, name, group_code, cron, misfire, timeout_ms, enabled FROM job_task
      WHERE handler LIKE 'wxoa.%' AND deleted_at IS NULL ORDER BY handler`,
  ),
})
type Installed = Awaited<ReturnType<typeof installed>>

/** The same rows without their ids (a re-install inserts new ones). */
const withoutIds = (rows: Installed) =>
  Object.fromEntries(
    Object.entries(rows).map(([k, list]) => [
      k,
      (list as object[]).map((r) =>
        Object.fromEntries(Object.entries(r).filter(([c]) => c !== 'id')),
      ),
    ]),
  )

const tablesPresent = async (q: DataSource): Promise<string[]> =>
  (
    await q.query(
      'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN (?) ORDER BY table_name',
      [TABLES],
    )
  ).map((r: { t: string }) => r.t)

/** Every check of a complete install. */
function expectInstalled(rows: Installed) {
  const group = rows.menus.find((m) => m.route_name === 'wxoa')
  expect(group).toMatchObject({
    kind: 'group',
    parent: null,
    name: 'menu.wxoa.title',
    route_path: '/wxoa',
    sort_no: 8,
  })
  const pages = rows.menus.filter((m) => m.kind === 'page')
  expect(pages.map((p) => [p.route_name, p.parent, p.component]).sort()).toEqual(
    PAGES.map((p) => [`wxoa-${p}`, 'wxoa', `platform/wxoa/${p}/index`]).sort(),
  )
  // one action per permission, under the page that uses it
  const actions = rows.menus.filter((m) => m.kind === 'action')
  const all = Object.values(wxoaPerms).flatMap((p) => Object.values(p))
  expect(actions.map((a) => a.perms).sort()).toEqual([...all].sort())
  // each resource's page; tags sit on the fan page, sending on the chat page, comments on the mass page
  const pageOf = (perm: string) => {
    const resource = perm.split('.')[1]
    if (perm === wxoaPerms.message.send) return 'wxoa-chat'
    if (resource === 'comment') return 'wxoa-mass'
    return `wxoa-${resource === 'tag' ? 'fan' : resource}`
  }
  expect(Object.fromEntries(actions.map((a) => [a.perms, a.parent]))).toEqual(
    Object.fromEntries(all.map((p) => [p, pageOf(p)])),
  )
  // dicts: the shared codes, in their order
  expect(rows.dicts.map((d: { code: string }) => d.code)).toEqual(Object.keys(DICT_VALUES).sort())
  for (const [code, values] of Object.entries(DICT_VALUES))
    expect(rows.entries.filter((e) => e.dict_code === code).map((e) => e.value)).toEqual([
      ...values,
    ])
  expect(rows.params).toEqual([
    expect.objectContaining({
      param_key: wxoaParams.copyInbound,
      param_value: 'true',
      group_code: 'wxoa',
      is_builtin: 1,
      is_public: 0,
    }),
    expect.objectContaining({
      param_key: wxoaParams.retentionDays,
      param_value: String(WXOA_RETENTION_DAYS_DEFAULT),
      group_code: 'wxoa',
      is_builtin: 1,
      is_public: 0,
    }),
  ])
  // the purge is off in test runs only; the fan sync is off until switched on
  expect(rows.tasks).toEqual([
    expect.objectContaining({
      handler: 'wxoa.fan.sync',
      name: 'seed.task.wxoaFanSync',
      group_code: 'system',
      enabled: 0,
    }),
    expect.objectContaining({
      handler: 'wxoa.message.purge',
      name: 'seed.task.wxoaMessagePurge',
      group_code: 'system',
      enabled: 0,
    }),
  ])
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(WxoaGateway)
    .useValue(fake.gateway)
    .compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.init()
  ds = app.get<DataSource>(getDataSourceToken())
  admin = (await signIn(app)).accessToken
})

afterAll(async () => {
  await app?.close()
})

it('fresh database: the group, all WX pages, one action per permission, dicts, params and tasks; root sees the group', async () => {
  expect(await tablesPresent(ds)).toEqual(TABLES)
  expectInstalled(await installed(ds))
  const res = await request(app.getHttpServer())
    .get('/api/auth/menus')
    .set(bearer(admin))
    .expect(200)
  const group = (res.body.data as MenuNode[]).find((n) => n.routeName === 'wxoa')!
  expect(group.children.map((n) => n.routeName)).toEqual(PAGES.map((p) => `wxoa-${p}`))
})

it('upgrade: a database from before the module gets the tables and seed rows by migrate → seed; seeding again changes nothing', async () => {
  const fresh = await installed(ds)
  const migrations = MIGRATIONS
  expect(migrations.map((M) => new M().name)).toContain('Tenancy20261007100000')
  const old = new DataSource({ ...dataSourceOptions(), migrations })
  await old.initialize()
  // runSeeds runs every domain: notices of other modules depend on what earlier specs left behind, so
  // only the rows are compared here
  try {
    try {
      // back to before the module: its tables, every later migration, their rows and the seed rows gone
      const runner = old.createQueryRunner()
      try {
        for (const M of [...migrations].reverse()) await new M().down(runner)
      } finally {
        await runner.release()
      }
      await old.query('DELETE FROM meta_migrations WHERE name IN (?)', [
        migrations.map((M) => new M().name),
      ])
      await old.query(
        "DELETE FROM iam_menu WHERE route_name = 'wxoa' OR route_name LIKE 'wxoa-%' OR perms LIKE 'wxoa.%'",
      )
      await old.query("DELETE FROM cfg_dict_entry WHERE dict_code LIKE 'wxoa.%'")
      await old.query("DELETE FROM cfg_dict WHERE code LIKE 'wxoa.%'")
      await old.query("DELETE FROM cfg_param WHERE param_key LIKE 'wxoa.%'")
      await old.query("DELETE FROM job_task WHERE handler LIKE 'wxoa.%'")
      expect(await tablesPresent(old)).toEqual([])
      expect(withoutIds(await installed(old))).toEqual({
        menus: [],
        dicts: [],
        entries: [],
        params: [],
        tasks: [],
      })
    } finally {
      // migrate → harden → seed, as the test database is built (also the way back when a step failed)
      expect((await restoreTestSchema(old)).map((m) => m.name)).toEqual(
        migrations.map((M) => new M().name),
      )
    }
    expect(await tablesPresent(old)).toEqual(TABLES)
    const upgraded = await installed(old)
    expectInstalled(upgraded)
    expect(withoutIds(upgraded)).toEqual(withoutIds(fresh))
    await runSeeds(old)
    expect(await installed(old)).toEqual(upgraded)
  } finally {
    await old.destroy()
  }
}, 120_000)

it('the module: the gateway is the fixture here (calls recorded, unexpected ones refused); the hub runs every handler; the media checker is registered', async () => {
  const caller = { id: 1, appId: 'wx0123456789abcdef', accountKind: 'sandbox' as const }
  fake.on('/cgi-bin/get_api_domain_ip', { ip_list: ['203.0.113.1'] })
  const gateway = app.get(WxoaGateway)
  expect(await gateway.json(caller, '/cgi-bin/get_api_domain_ip')).toEqual({
    ip_list: ['203.0.113.1'],
  })
  expect(fake.callsTo('/cgi-bin/get_api_domain_ip')).toEqual([
    { method: 'json', path: '/cgi-bin/get_api_domain_ip', accountId: 1 },
  ])
  await expect(gateway.json(caller, '/cgi-bin/menu/create')).rejects.toThrow('no answer')
  fake.reset()

  const hub = app.get(WxoaInboundHub)
  const seen: string[] = []
  hub.on(async () => {
    throw new BizError(Err.WXOA_UPSTREAM)
  })
  hub.on(async (row) => {
    seen.push(`${row.id}:${row.msgKind}`)
  })
  const row: WxoaInbound = {
    id: 41,
    accountId: 1,
    openId: 'o-install',
    msgKind: 'text',
    eventKind: null,
    eventKey: null,
    wxMsgId: '18446744073709551615',
    payload: { Content: 'hi' },
    occurredAt: new Date(),
  }
  await hub.emit(row)
  expect(seen).toEqual(['41:text'])

  expect(() => app.get(StorageAccess).register(WXOA_MEDIA_TAG, async () => true)).toThrow(
    'already has a checker',
  )
})

it('codegen: the wxoa tables are never importable', async () => {
  const http = () => request(app.getHttpServer())
  const res = await http().get('/api/codegen/tables/importable').set(bearer(admin)).expect(200)
  const names = (res.body.data as { tableName: string }[]).map((t) => t.tableName)
  expect(names).toContain('iam_role')
  expect(names.filter((n) => n.startsWith('wxoa_'))).toEqual([])
  const refused = await http()
    .post('/api/codegen/tables/import')
    .set(bearer(admin))
    .send({ tableNames: ['wxoa_account'] })
    .expect(422)
  expect(refused.body.code).toBe(Err.CODEGEN_TABLE_UNAVAILABLE.code)
})

it('Swagger: the callback is public, takes XML and lists its bare status codes; every management route lists its error codes', async () => {
  const doc = (await request(app.getHttpServer()).get('/api/docs-json').expect(200)).body
  expect(doc.security).toEqual([{ bearer: [] }])
  const callback = doc.paths['/api/wxoa/callback/{key}']
  expect(callback.get.security).toEqual([])
  expect(callback.post.security).toEqual([])
  expect(Object.keys(callback.get.responses).sort()).toEqual(['200', '404', '429'])
  expect(Object.keys(callback.post.responses).sort()).toEqual([
    '200',
    '400',
    '403',
    '404',
    '413',
    '429',
  ])
  const required = (op: { parameters: { in: string; name: string; required?: boolean }[] }) =>
    op.parameters
      .filter((p) => p.in === 'query' && p.required)
      .map((p) => p.name)
      .sort()
  expect(required(callback.get)).toEqual(['echostr', 'nonce', 'signature', 'timestamp'])
  expect(required(callback.post)).toEqual(['nonce', 'timestamp'])
  expect(Object.keys(callback.post.requestBody.content)).toEqual(['text/xml'])
  expect(Object.keys(callback.post.responses['200'].content).sort()).toEqual([
    'text/plain',
    'text/xml',
  ])

  const codes = [
    Err.DEMO_READ_ONLY,
    Err.NOT_FOUND,
    Err.STORAGE_FILE_REQUIRED,
    Err.DUPLICATE,
    Err.IN_USE,
    Err.PAYLOAD_TOO_LARGE,
    Err.UNPROCESSABLE,
    Err.STORAGE_TYPE_REJECTED,
    Err.TOO_MANY_REQUESTS,
    ...Object.entries(Err)
      .filter(([name]) => name.startsWith('WXOA_'))
      .map(([, e]) => e),
  ]
  // the shared codes every route may answer plus each of the module's own, none twice
  expect(codes.length).toBeGreaterThan(9)
  expect(new Set(codes.map((e) => e.code)).size).toBe(codes.length)
  const operations = Object.entries(doc.paths as Record<string, Record<string, unknown>>)
    .filter(([path]) => path.startsWith('/api/wxoa/') && !path.startsWith('/api/wxoa/callback/'))
    .flatMap(([path, ops]) =>
      Object.entries(ops).map(([method, op]) => ({
        at: `${method} ${path}`,
        ...(op as { security?: unknown; responses: Record<string, { description: string }> }),
      })),
    )
  expect(operations.length).toBeGreaterThan(50)
  // the document's bearer requirement applies to each (no own security), every code under its status
  const gaps = operations.flatMap((op) => [
    ...(op.security === undefined ? [] : [`${op.at}: security`]),
    ...codes
      .filter((e) => !op.responses[e.status]?.description.includes(e.code))
      .map((e) => `${op.at}: ${e.code}`),
  ])
  expect(gaps).toEqual([])
})
