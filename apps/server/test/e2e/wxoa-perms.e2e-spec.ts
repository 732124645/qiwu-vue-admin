// Permissions of the Official Account API (see docs/design-notes.md#wxoa), table-driven: every management
// route with the permission it requires (any of the listed ones). For each route a user holding every
// other wxoa permission — none of the route's — is refused 403 before anything else runs, so a route that
// lost its `@RequirePerm`, or took another permission, fails here. The table matches the routes the app
// serves (its API document), so a new route needs a row. With the switch on (the test env) the module's
// group is in the side menu and the role grant tree, and its job handlers are registered.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { type MenuNode, type RoleMenuNode, WXOA_BROWSE_PERMS, wxoaPerms } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { findId, insertRow } from '../../src/db/seeds/upsert.js'
import { JobRegistry } from '../../src/modules/platform/scheduler/job-registry.js'
import { WxoaGateway } from '../../src/modules/platform/wxoa/core/wxoa-gateway.js'
import { fakeWxoaGateway } from '../fixtures/wxoa/fake-gateway.js'
import { bearer, signIn } from '../setup/auth.js'
import { inTenant1 } from '../setup/tenants.js'

const PREFIX = 'e2e-wxoa-perms-'
const {
  account,
  comment,
  draft,
  fan,
  tag,
  mass,
  material,
  menu,
  message,
  notice,
  publish,
  qrcode,
  reply,
  stat,
  template,
} = wxoaPerms

type Method = 'get' | 'post' | 'put' | 'delete'
/** method, path under /api/wxoa, the permissions the route takes (any of them) */
const ROUTES: [Method, string, readonly string[]][] = [
  ['get', 'accounts', [account.browse]],
  ['get', 'accounts/options', WXOA_BROWSE_PERMS],
  ['get', 'accounts/:id', [account.browse]],
  ['post', 'accounts', [account.create]],
  ['put', 'accounts/:id', [account.modify]],
  ['delete', 'accounts/:id', [account.remove]],
  ['post', 'accounts/:id/test', [account.modify]],
  ['get', 'accounts/:id/quota', [account.browse]],
  ['post', 'accounts/:id/quota/clear', [account['clear-quota']]],
  ['get', 'comments', [comment.browse]],
  ['post', 'comments/open', [comment.modify]],
  ['post', 'comments/close', [comment.modify]],
  ['post', 'comments/:commentId/elect', [comment.modify]],
  ['delete', 'comments/:commentId/elect', [comment.modify]],
  ['delete', 'comments/:commentId', [comment.remove]],
  ['post', 'comments/:commentId/reply', [comment.send]],
  ['delete', 'comments/:commentId/reply', [comment.remove]],
  ['get', 'drafts', [draft.browse]],
  ['get', 'drafts/:id', [draft.browse]],
  ['post', 'drafts', [draft.create]],
  ['put', 'drafts/:id', [draft.modify]],
  ['delete', 'drafts/:id', [draft.remove]],
  ['post', 'drafts/:id/sync', [draft.sync]],
  ['post', 'drafts/pull', [draft.sync]],
  ['get', 'fans', [fan.browse]],
  ['get', 'fans/export', [fan.export]],
  ['get', 'fans/sync', [fan.browse]],
  ['post', 'fans/sync', [fan.sync]],
  ['post', 'fans/tagging', [fan.modify]],
  ['post', 'fans/blocking', [fan.modify]],
  ['get', 'fans/:id', [fan.browse]],
  ['put', 'fans/:id/remark', [fan.modify]],
  ['get', 'tags', [tag.browse]],
  ['post', 'tags/sync', [fan.sync]],
  ['post', 'tags', [tag.create]],
  ['put', 'tags/:id', [tag.modify]],
  ['delete', 'tags/:id', [tag.remove]],
  ['get', 'mass-jobs', [mass.browse]],
  ['get', 'mass-jobs/:id', [mass.browse]],
  ['post', 'mass-jobs', [mass.send]],
  ['post', 'mass-jobs/preview', [mass.send]],
  ['post', 'mass-jobs/:id/retry', [mass.send]],
  ['delete', 'mass-jobs/:id', [mass.remove]],
  ['get', 'materials', [material.browse]],
  ['get', 'materials/counts', [material.browse]],
  ['get', 'materials/sync', [material.browse]],
  ['post', 'materials/sync', [material.sync]],
  ['post', 'materials', [material.create]],
  ['delete', 'materials/:id', [material.remove]],
  ['get', 'menus', [menu.browse]],
  ['post', 'menus/pull', [menu.modify]],
  ['post', 'menus/clear', [menu.publish]],
  ['post', 'menus/try-match', [menu.browse]],
  ['get', 'menus/:id', [menu.browse]],
  ['post', 'menus', [menu.modify]],
  ['put', 'menus/:id', [menu.modify]],
  ['delete', 'menus/:id', [menu.modify]],
  ['post', 'menus/:id/publish', [menu.publish]],
  ['get', 'messages', [message.browse]],
  ['post', 'messages', [message.send]],
  ['get', 'conversations', [message.browse]],
  ['get', 'conversations/:fanId/messages', [message.browse]],
  ['get', 'conversations/:fanId/window', [message.browse]],
  ['get', 'notice-templates', [notice.browse]],
  ['get', 'notice-templates/library', [notice.browse]],
  ['post', 'notice-templates', [notice.modify]],
  ['delete', 'notice-templates/:priTmplId', [notice.modify]],
  ['post', 'notice-templates/:priTmplId/send', [notice.send]],
  ['get', 'publishes', [publish.browse]],
  ['get', 'publishes/:id', [publish.browse]],
  ['post', 'publishes', [publish.create]],
  ['post', 'publishes/pull', [publish.create]],
  ['delete', 'publishes/:id', [publish.remove]],
  ['get', 'qrcodes', [qrcode.browse]],
  ['post', 'qrcodes', [qrcode.create]],
  ['put', 'qrcodes/:id', [qrcode.modify]],
  ['delete', 'qrcodes/:id', [qrcode.remove]],
  ['get', 'qrcodes/:id/stats', [qrcode.browse]],
  ['get', 'reply-rules', [reply.browse]],
  ['get', 'reply-rules/:id', [reply.browse]],
  ['post', 'reply-rules', [reply.create]],
  ['put', 'reply-rules/:id', [reply.modify]],
  ['delete', 'reply-rules/:id', [reply.remove]],
  ['get', 'stats/users', [stat.browse]],
  ['get', 'stats/messages', [stat.browse]],
  ['get', 'stats/interfaces', [stat.browse]],
  ['get', 'stats/articles', [stat.browse]],
  ['get', 'templates', [template.browse]],
  ['get', 'templates/industry', [template.browse]],
  ['delete', 'templates/:templateId', [template.remove]],
  ['post', 'templates/:templateId/send', [template.send]],
]
const ALL_PERMS = Object.values(wxoaPerms).flatMap((p) => Object.values(p))

const fake = fakeWxoaGateway()
let app: NestExpressApplication
let ds: DataSource
let root = ''
/** the token of a user holding every wxoa permission but these (joined by ',') */
const without = new Map<string, string>()
const roleIds: number[] = []
const userIds: number[] = []

const http = () => request(app.getHttpServer())
const ids = (nodes: { id: number; children: { id: number }[] }[]): number[] =>
  nodes.flatMap((n) => [n.id, ...ids(n.children as typeof nodes)])

/** A user (and role) of the default tenant holding exactly `perms`; returns its access token. */
async function holder(name: string, perms: readonly string[]): Promise<string> {
  const roleId = await inTenant1(() =>
    insertRow(ds.manager, 'iam_role', {
      code: `${PREFIX}${name}`,
      name: `${PREFIX}${name}`,
      data_scope: 'all',
    }),
  )
  roleIds.push(roleId)
  const menus = await ds.query<{ id: number }[]>(
    'SELECT id FROM iam_menu WHERE perms IN (?) AND deleted_at IS NULL',
    [perms],
  )
  expect(menus).toHaveLength(perms.length)
  await ds.query('INSERT INTO iam_role_menus (tenant_id, role_id, menu_id) VALUES ?', [
    menus.map((m) => [1, roleId, Number(m.id)]),
  ])
  const userId = await inTenant1(() =>
    insertRow(ds.manager, 'iam_user', {
      username: `${PREFIX}${name}`,
      display_name: name,
      password_hash: 'not-used-by-this-spec',
      password_changed_at: new Date(),
    }),
  )
  userIds.push(userId)
  await ds.query('INSERT INTO iam_user_roles (tenant_id, user_id, role_id) VALUES (1, ?, ?)', [
    userId,
    roleId,
  ])
  return (await signIn(app, `${PREFIX}${name}`)).accessToken
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(WxoaGateway)
    .useValue(fake.gateway)
    .compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.init()
  ds = app.get<DataSource>(getDataSourceToken())
  root = (await signIn(app)).accessToken
  for (const [, , perms] of ROUTES) {
    const key = [...perms].sort().join(',')
    if (!without.has(key))
      without.set(
        key,
        await holder(
          String(without.size),
          ALL_PERMS.filter((p) => !perms.includes(p)),
        ),
      )
  }
}, 60_000)

afterAll(async () => {
  if (ds) {
    if (userIds.length) {
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [userIds])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [userIds])
    }
    if (roleIds.length) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id IN (?)', [roleIds])
      await ds.query('DELETE FROM iam_role WHERE id IN (?)', [roleIds])
    }
  }
  await app?.close()
})

it('the table lists every management route the app serves', async () => {
  const doc = (await http().get('/api/docs-json').expect(200)).body as {
    paths: Record<string, Record<string, unknown>>
  }
  const served = Object.entries(doc.paths)
    .filter(([path]) => path.startsWith('/api/wxoa/') && !path.startsWith('/api/wxoa/callback/'))
    .flatMap(([path, ops]) =>
      Object.keys(ops).map(
        (method) => `${method} ${path.slice('/api/wxoa/'.length).replace(/\{(\w+)\}/g, ':$1')}`,
      ),
    )
    .sort()
  expect(ROUTES.map(([method, path]) => `${method} ${path}`).sort()).toEqual(served)
  // every wxoa permission guards at least one route
  expect(ALL_PERMS.filter((p) => !ROUTES.some(([, , perms]) => perms.includes(p)))).toEqual([])
})

it.each(ROUTES)('%s /api/wxoa/%s: 403 without its permission', async (method, path, perms) => {
  const token = without.get([...perms].sort().join(','))!
  const url = `/api/wxoa/${path.replace(/:\w+/g, '1')}`
  const res = await http()[method](url).set(bearer(token)).send({ accountId: 1 })
  expect([url, res.status]).toEqual([url, 403])
  expect(fake.calls).toEqual([])
})

it('with the switch on: the group is in the side menu and the grant tree, its job handlers are registered', async () => {
  const group = await inTenant1(() => findId(ds.manager, 'iam_menu', { route_name: 'wxoa' }))
  const side = (await http().get('/api/auth/menus').set(bearer(root)).expect(200)).body
    .data as MenuNode[]
  expect(side.find((n) => n.routeName === 'wxoa')?.children.length).toBeGreaterThan(0)
  const tree = ids(
    (await http().get('/api/iam/roles/menu-tree').set(bearer(root)).expect(200)).body
      .data as RoleMenuNode[],
  )
  expect(tree).toContain(group)
  const jobs = app.get(JobRegistry)
  expect(jobs.get('wxoa.fan.sync')).toBeDefined()
  expect(jobs.get('wxoa.message.purge')).toBeDefined()
})
