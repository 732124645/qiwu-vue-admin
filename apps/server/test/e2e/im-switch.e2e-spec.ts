// 员工聊天的启动开关（see docs/im.md），这里关闭（`APP_IM=false`；测试环境默认打开，其它聊天规格都带模块）：
// 模块不加载，每个 /api/im 路由族 404；清理任务的处理器不注册，启用的任务行也不排进调度；通用上传拿聊天
// 标签 400（与开关无关）；角色授权树与套餐编辑树不显示隐藏的聊天分组，菜单管理照样列出它。
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import type { RoleMenuNode } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { findId } from '../../src/db/seeds/upsert.js'
import { TenantPackageService } from '../../src/modules/platform/iam/tenant-package/tenant-package.service.js'
import { JobRegistry } from '../../src/modules/platform/scheduler/job-registry.js'
import { JobScheduler } from '../../src/modules/platform/scheduler/job-scheduler.js'
import { bearer, signIn } from '../setup/auth.js'
import { inTenant1 } from '../setup/tenants.js'

// AppModule 导入之前：模块列表在加载时读开关
vi.hoisted(() => {
  process.env.APP_IM = 'false'
})

let app: NestExpressApplication
let ds: DataSource
let root: string

const http = () => request(app.getHttpServer())
const ids = (nodes: { id: number; children: { id: number }[] }[]): number[] =>
  nodes.flatMap((n) => [n.id, ...ids(n.children as typeof nodes)])

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.init()
  ds = app.get<DataSource>(getDataSourceToken())
  root = (await signIn(app)).accessToken
})

afterAll(async () => {
  await app?.close()
})

it('every /api/im route family is 404', async () => {
  for (const [method, path] of [
    ['get', '/api/im/options'],
    ['get', '/api/im/sync'],
    ['get', '/api/im/sync?ids=1'],
    ['get', '/api/im/directory'],
    ['post', '/api/im/rooms/directs'],
    ['post', '/api/im/rooms/groups'],
    ['get', '/api/im/rooms/1/members'],
    ['post', '/api/im/rooms/1/members'],
    ['delete', '/api/im/rooms/1/members/2'],
    ['post', '/api/im/rooms/1/leave'],
    ['put', '/api/im/rooms/1/owner'],
    ['put', '/api/im/rooms/1/members/2/role'],
    ['put', '/api/im/rooms/1/label'],
    ['post', '/api/im/rooms/1/close'],
    ['put', '/api/im/rooms/1/read'],
    ['get', '/api/im/rooms/1/entries'],
    ['post', '/api/im/rooms/1/uploads'],
    ['post', '/api/im/rooms/1/voice-uploads'],
    ['get', '/api/im/calls/active'],
    ['get', '/api/im/calls/1'],
    ['post', '/api/im/rooms/1/calls'],
    ['post', '/api/im/calls/1/accept'],
    ['post', '/api/im/calls/1/decline'],
    ['post', '/api/im/calls/1/join'],
    ['post', '/api/im/calls/1/leave'],
    ['post', '/api/im/calls/1/end'],
    ['post', '/api/im/calls/1/heartbeat'],
    ['post', '/api/im/rooms/1/entries'],
    ['put', '/api/im/rooms/1/entries/1'],
    ['post', '/api/im/rooms/1/entries/1/recall'],
    ['get', '/api/im/rooms/1/entries/1/file'],
    ['get', '/api/im/stickers'],
    ['post', '/api/im/stickers'],
    ['post', '/api/im/stickers/from-entry'],
    ['put', '/api/im/stickers/order'],
    ['get', '/api/im/stickers/1/file'],
    ['delete', '/api/im/stickers/1'],
  ] as const)
    await http()[method](path).set(bearer(root)).send({}).expect(404)
})

it('the purge handler is not registered and its enabled task is not scheduled', async () => {
  const jobs = app.get(JobRegistry)
  expect(jobs.get('im.purge')).toBeUndefined()
  expect(jobs.list().filter((h) => h.name.startsWith('im.'))).toEqual([])
  const [task] = await ds.query<{ id: number; enabled: number }[]>(
    "SELECT id, enabled FROM job_task WHERE handler = 'im.purge' AND deleted_at IS NULL",
  )
  expect(task).toBeDefined()
  const scheduler = app.get(JobScheduler)
  await ds.query('UPDATE job_task SET enabled = 1 WHERE id = ?', [task!.id])
  try {
    await scheduler.sync(Number(task!.id))
    expect(scheduler.isScheduled(Number(task!.id))).toBe(false)
  } finally {
    await ds.query('UPDATE job_task SET enabled = ? WHERE id = ?', [task!.enabled, task!.id])
  }
})

it('the generic upload refuses the chat tags', async () => {
  for (const bizTag of ['im.attachment', 'im.sticker'])
    await http()
      .post('/api/storage/objects')
      .set(bearer(root))
      .field('bizTag', bizTag)
      .attach('file', Buffer.from('plain text'), 'note.txt')
      .expect(400)
})

it('the grant trees leave the hidden chat group out; the menu management lists it', async () => {
  const group = await inTenant1(() => findId(ds.manager, 'iam_menu', { route_name: 'im' }))
  expect(group).toBeDefined()
  const tree = ids(
    (await http().get('/api/iam/roles/menu-tree').set(bearer(root)).expect(200)).body
      .data as RoleMenuNode[],
  )
  expect(tree).not.toContain(group)
  const packageTree = ids(await inTenant1(() => app.get(TenantPackageService).menuTree()))
  expect(packageTree).not.toContain(group)
  expect(packageTree.length).toBeGreaterThan(0)
  const listed = ids((await http().get('/api/iam/menus').set(bearer(root)).expect(200)).body.data)
  expect(listed).toContain(group)
})
