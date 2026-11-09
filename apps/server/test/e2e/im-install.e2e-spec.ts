// 员工聊天的安装与边界（see docs/im.md）：迁移与种子后的参数默认值、清理任务行与隐藏的聊天分组；再跑种子
// 不改任何东西（epoch 与管理员改过的值都保留）；保留天数与 epoch 只许 root 改；会员身份访问每个路由族 403
// B5001，没有任何角色的员工照常可用；租户套餐不含聊天分组的租户 404、含的 200，默认租户与多租户关闭时不受
// 限；分组第一次建出时补进现有套餐、root 之后去掉的不会被种子加回；平台用户代入别的租户时仍在本人租户聊天；
// 聊天表从不提供给代码生成器导入。两个应用共用一个库：`on`（多租户开）与 `off`（多租户关），都打开 APP_IM。
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import {
  Err,
  IM_INT_PARAMS,
  imParams,
  DEFAULT_IM_FILE_EXTS,
  DEFAULT_IM_GROUP_RECALL_ANYTIME,
} from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { runSeeds } from '../../src/db/seeds/index.js'
import { seedIm } from '../../src/db/seeds/im/im.seed.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { bearer, signIn } from '../setup/auth.js'
import {
  addUser,
  bootApp,
  createPackage,
  createTenant,
  inTenant1,
  type PeopledTenant,
  signInDirect,
  type TestPackage,
} from '../setup/tenants.js'

const PREFIX = 'im-install-'

let on: NestExpressApplication
let off: NestExpressApplication
let ds: DataSource
let imGroup = 0
let staffId = 0
let memberId = 0
let editorId = 0
let editorRole = 0
let withIm: PeopledTenant
let withoutIm: PeopledTenant
let noImPackage: TestPackage
const madeUsers: number[] = []
const madeRooms: number[] = []

/** 只读的路由族（200 / 404 的判定用它们）。 */
const READS = ['/api/im/options', '/api/im/sync', '/api/im/directory', '/api/im/stickers'] as const

/**
 * 每个路由族各一个代表（身份与功能守卫都在校验之前，空请求体也是 403/404）。表情编号用 0：校验拒绝它，
 * 服务层不会回答“表情不存在”的 404，套餐用例才能分清那是功能守卫给的。
 */
const FAMILIES = [
  ['get', '/api/im/options'],
  ['get', '/api/im/sync'],
  ['get', '/api/im/sync?ids=1'],
  ['get', '/api/im/directory'],
  ['post', '/api/im/rooms/directs'],
  ['post', '/api/im/rooms/groups'],
  ['get', '/api/im/rooms/1/members'],
  ['put', '/api/im/rooms/1/read'],
  ['get', '/api/im/rooms/1/entries'],
  ['post', '/api/im/rooms/1/entries'],
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
  ['get', '/api/im/rooms/1/entries/1/file'],
  ['get', '/api/im/stickers'],
  ['post', '/api/im/stickers/from-entry'],
  ['get', '/api/im/stickers/0/file'],
  ['delete', '/api/im/stickers/0'],
] as const

const tokenOf = async (app: NestExpressApplication, userId: number) =>
  (await signInDirect(app, userId))!.accessToken
const get = (app: NestExpressApplication, path: string, token: string) =>
  request(app.getHttpServer()).get(path).set(bearer(token))

/** 种子拥有的全部行（稳定顺序）。 */
const installed = async () => ({
  params: await ds.query(
    `SELECT param_key, param_value, name, name_i18n, group_code, is_builtin, is_public FROM cfg_param
      WHERE param_key LIKE 'im.%' AND deleted_at IS NULL ORDER BY param_key`,
  ),
  tasks: await ds.query(
    `SELECT id, handler, name, group_code, cron, misfire, timeout_ms, enabled FROM job_task
      WHERE handler LIKE 'im.%' AND deleted_at IS NULL ORDER BY id`,
  ),
  menus: await ds.query(
    `SELECT id, parent_id, kind, name, route_path, icon, visible, sort_no, perms FROM iam_menu
      WHERE route_name = 'im' AND deleted_at IS NULL`,
  ),
})

const paramValue = async (key: string): Promise<string> =>
  (
    await ds.query<{ v: string }[]>(
      'SELECT param_value AS v FROM cfg_param WHERE param_key = ? AND deleted_at IS NULL',
      [key],
    )
  )[0]!.v

beforeAll(async () => {
  on = await bootApp({ multiTenant: true })
  off = await bootApp({ multiTenant: false })
  ds = on.get<DataSource>(getDataSourceToken())
  imGroup = Number(
    (
      await ds.query<{ id: number }[]>(
        "SELECT id FROM iam_menu WHERE route_name = 'im' AND deleted_at IS NULL",
      )
    )[0]!.id,
  )
  staffId = await addUser(on, 1, `${PREFIX}staff`)
  memberId = await addUser(on, 1, `${PREFIX}member`)
  await ds.query("UPDATE iam_user SET user_type = 'member' WHERE id = ?", [memberId])
  editorId = await addUser(on, 1, `${PREFIX}editor`)
  madeUsers.push(staffId, memberId, editorId)
  editorRole = await inTenant1(() =>
    insertRow(ds.manager, 'iam_role', {
      code: `${PREFIX}params`,
      name: `${PREFIX}params`,
      data_scope: 'all',
    }),
  )
  await ds.query('INSERT INTO iam_user_roles (user_id, role_id, tenant_id) VALUES (?, ?, 1)', [
    editorId,
    editorRole,
  ])
  for (const m of await ds.query<{ id: number }[]>(
    "SELECT id FROM iam_menu WHERE perms IN ('settings.param.browse', 'settings.param.modify') AND deleted_at IS NULL",
  ))
    await ds.query('INSERT INTO iam_role_menus (role_id, menu_id, tenant_id) VALUES (?, ?, 1)', [
      editorRole,
      m.id,
    ])
  const open = (
    await ds.query<{ id: number }[]>(
      'SELECT id FROM iam_menu WHERE platform_only = 0 AND deleted_at IS NULL',
    )
  ).map((r) => Number(r.id))
  noImPackage = await createPackage(on, { menuIds: open.filter((id) => id !== imGroup) })
  withIm = await createTenant(on, { users: true })
  withoutIm = await createTenant(on, { users: true, packageId: noImPackage.id })
})

afterAll(async () => {
  await withIm?.dispose()
  await withoutIm?.dispose()
  await noImPackage?.dispose()
  if (ds) {
    if (madeRooms.length) {
      await ds.query('DELETE FROM im_roster WHERE room_id IN (?)', [madeRooms])
      await ds.query('DELETE FROM im_room WHERE id IN (?)', [madeRooms])
    }
    await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [editorRole])
    await ds.query('DELETE FROM iam_user_roles WHERE role_id = ?', [editorRole])
    await ds.query('DELETE FROM iam_role WHERE id = ?', [editorRole])
    if (madeUsers.length) await ds.query('DELETE FROM iam_user WHERE id IN (?)', [madeUsers])
  }
  await on?.close()
  await off?.close()
})

it('seeds the params with their defaults, the daily purge task (off in test runs) and the hidden chat group', async () => {
  const { params, tasks, menus } = await installed()
  const values = Object.fromEntries(
    (params as { param_key: string; param_value: string }[]).map((p) => [
      p.param_key,
      p.param_value,
    ]),
  )
  expect(Object.keys(values).sort()).toEqual(Object.values(imParams).sort())
  expect(values).toMatchObject({
    [imParams.retentionDays]: String(IM_INT_PARAMS.retentionDays.fallback),
    [imParams.textMaxChars]: '5000',
    [imParams.recallMinutes]: '2',
    [imParams.editMinutes]: '5',
    [imParams.groupRecallAnytime]: String(DEFAULT_IM_GROUP_RECALL_ANYTIME),
    [imParams.groupMaxMembers]: '200',
    [imParams.fileMaxMb]: '20',
    [imParams.fileExts]: DEFAULT_IM_FILE_EXTS,
  })
  expect(IM_INT_PARAMS.retentionDays.fallback).toBe(180)
  expect(values[imParams.epoch]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
  for (const p of params as { group_code: string; is_builtin: number; is_public: number }[])
    expect(p).toMatchObject({ group_code: 'im', is_builtin: 1, is_public: 0 })
  expect(tasks).toEqual([
    expect.objectContaining({
      handler: 'im.purge',
      name: 'seed.task.imPurge',
      group_code: 'system',
      misfire: 'run_once',
      enabled: 0,
    }),
  ])
  expect(menus).toEqual([
    expect.objectContaining({
      parent_id: 0,
      kind: 'group',
      name: 'menu.im.title',
      route_path: '/im',
      visible: 0,
      perms: null,
    }),
  ])
  // 没有页面与权限：只供套餐勾选
  expect(
    await ds.query('SELECT id FROM iam_menu WHERE parent_id = ? AND deleted_at IS NULL', [imGroup]),
  ).toEqual([])
  // 侧栏：分组即使出现在 /menus 里也标为不可见（web 不显示不可见与空的分组）
  const side = (await get(on, '/api/auth/menus', (await signIn(on)).accessToken).expect(200)).body
    .data as { routeName: string | null; visible: boolean }[]
  expect(side.filter((n) => n.routeName === 'im' && n.visible)).toEqual([])
})

it('seeding again changes nothing: the epoch and the values administrators changed stay', async () => {
  const before = await installed()
  await runSeeds(ds, ['im'])
  expect(await installed()).toEqual(before)
  const epoch = await paramValue(imParams.epoch)
  const max = await paramValue(imParams.textMaxChars)
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [
    'restored-backup',
    imParams.epoch,
  ])
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [
    '100',
    imParams.textMaxChars,
  ])
  try {
    await runSeeds(ds, ['im'])
    expect(await paramValue(imParams.epoch)).toBe('restored-backup')
    expect(await paramValue(imParams.textMaxChars)).toBe('100')
  } finally {
    await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [
      epoch,
      imParams.epoch,
    ])
    await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [
      max,
      imParams.textMaxChars,
    ])
  }
})

it("the retention and the epoch are root's: a param editor 403, root 200", async () => {
  const editor = await tokenOf(on, editorId)
  const root = (await signIn(on)).accessToken
  for (const key of [imParams.retentionDays, imParams.epoch]) {
    const [row] = await ds.query<{ id: number; param_value: string }[]>(
      'SELECT id, param_value FROM cfg_param WHERE param_key = ? AND deleted_at IS NULL',
      [key],
    )
    const put = (token: string) =>
      request(on.getHttpServer())
        .put(`/api/settings/params/${row!.id}`)
        .set(bearer(token))
        .send({ paramValue: row!.param_value })
    expect((await put(editor).expect(403)).body.code).toBe(Err.IAM_GRANT_EXCEEDS_OWN.code)
    await put(root).expect(200)
  }
  // 其它聊天参数照常归参数管理员
  const [plain] = await ds.query<{ id: number; param_value: string }[]>(
    'SELECT id, param_value FROM cfg_param WHERE param_key = ? AND deleted_at IS NULL',
    [imParams.recallMinutes],
  )
  await request(on.getHttpServer())
    .put(`/api/settings/params/${plain!.id}`)
    .set(bearer(editor))
    .send({ paramValue: plain!.param_value })
    .expect(200)
})

it('a member identity gets 403 B5001 on every route family; a staff member without any role uses chat', async () => {
  const member = await tokenOf(on, memberId)
  for (const [method, path] of FAMILIES) {
    const res = await request(on.getHttpServer())[method](path).set(bearer(member)).send({})
    expect([method, path, res.status, res.body.code]).toEqual([
      method,
      path,
      403,
      Err.IM_STAFF_ONLY.code,
    ])
  }
  const staff = await tokenOf(on, staffId)
  for (const path of READS) await get(on, path, staff).expect(200)
})

it('tenant packages: without the chat group 404, with it 200; the default tenant and multi-tenancy off are not limited', async () => {
  const outside = await tokenOf(on, withoutIm.users.alice)
  const inside = await tokenOf(on, withIm.users.alice)
  // 每个路由族：套餐不含 → 功能守卫的 404（不是会话不存在的 B5002）；含 → 不再是那个码
  for (const [method, path] of FAMILIES) {
    const out = await request(on.getHttpServer())[method](path).set(bearer(outside)).send({})
    expect([method, path, out.status, out.body.code]).toEqual([
      method,
      path,
      404,
      Err.NOT_FOUND.code,
    ])
    const res = await request(on.getHttpServer())[method](path).set(bearer(inside)).send({})
    expect([method, path, res.body.code]).not.toEqual([method, path, Err.NOT_FOUND.code])
  }
  for (const path of READS) await get(on, path, inside).expect(200)
  const staffOn = await tokenOf(on, staffId)
  const staffOff = await tokenOf(off, staffId)
  for (const path of READS) {
    await get(on, path, staffOn).expect(200)
    await get(off, path, staffOff).expect(200)
  }
})

it('a platform user inside another tenant still chats in their own tenant', async () => {
  const rootId = Number(
    (
      await ds.query<{ id: number }[]>(
        "SELECT id FROM iam_user WHERE tenant_id = 1 AND username = 'admin' AND deleted_at IS NULL",
      )
    )[0]!.id,
  )
  const room = async (tenantId: number, userId: number) => {
    const { insertId } = await ds.query<{ insertId: number }>(
      "INSERT INTO im_room (tenant_id, room_kind, label, last_seq) VALUES (?, 'group', ?, 0)",
      [tenantId, `${PREFIX}room`],
    )
    madeRooms.push(Number(insertId))
    await ds.query(
      `INSERT INTO im_roster (tenant_id, room_id, user_id, role_code, member_label, visible_from_seq)
       VALUES (?, ?, ?, 'owner', 'x', 1)`,
      [tenantId, insertId, userId],
    )
    return Number(insertId)
  }
  const own = await room(1, rootId)
  const theirs = await room(withIm.id, withIm.users.admin)
  const token = (await signIn(on)).accessToken
  await request(on.getHttpServer())
    .post(`/api/iam/tenants/${withIm.id}/enter`)
    .set(bearer(token))
    .send({ reason: 'Chat support' })
    .expect(200)
  const sync = (await get(on, '/api/im/sync', token).expect(200)).body.data as {
    rooms: number[][]
  }
  const ids = sync.rooms.map((t) => t[0])
  expect(ids).toContain(own)
  expect(ids).not.toContain(theirs)
  const details = (await get(on, `/api/im/sync?ids=${own},${theirs}`, token).expect(200)).body
    .data as { roomId: number }[]
  expect(details.map((d) => d.roomId)).toEqual([own])
  // 会话与消息路由族同样落在本人租户
  await get(on, `/api/im/rooms/${own}/members`, token).expect(200)
  await get(on, `/api/im/rooms/${own}/entries`, token).expect(200)
  const res = await get(on, `/api/im/rooms/${theirs}/members`, token).expect(404)
  expect(res.body.code).toBe(Err.IM_ROOM_NOT_FOUND.code)
  // 通讯录与我的表情也是本人租户的
  const dir = (await get(on, '/api/im/directory', token).expect(200)).body.data as {
    users: { id: number }[]
  }
  expect(dir.users.map((u) => u.id)).toContain(rootId)
  expect(dir.users.map((u) => u.id)).not.toContain(withIm.users.alice)
  const storageId = Number(
    (
      await ds.query<{ id: number }[]>(
        'SELECT id FROM fs_storage WHERE is_primary = 1 AND deleted_at IS NULL LIMIT 1',
      )
    )[0]!.id,
  )
  const { insertId: objectId } = await ds.query<{ insertId: number }>(
    `INSERT INTO fs_object (tenant_id, storage_id, object_key, original_name, mime, size, biz_tag, uploader_id)
     VALUES (1, ?, ?, 's.webp', 'image/webp', 10, 'im.sticker', ?)`,
    [storageId, `${PREFIX}${Date.now()}.webp`, rootId],
  )
  const { insertId: stickerId } = await ds.query<{ insertId: number }>(
    `INSERT INTO im_sticker (tenant_id, user_id, object_id, sha256, mime, width, height)
     VALUES (1, ?, ?, ?, 'image/webp', 10, 10)`,
    [rootId, objectId, 'a'.repeat(64)],
  )
  try {
    const stickers = (await get(on, '/api/im/stickers', token).expect(200)).body.data as {
      id: number
    }[]
    expect(stickers.map((s) => s.id)).toContain(Number(stickerId))
  } finally {
    await ds.query('DELETE FROM im_sticker WHERE id = ?', [stickerId])
    await ds.query('DELETE FROM fs_object WHERE id = ?', [objectId])
  }
})

it('a new chat group joins every existing package once; one root removed it from stays without it', async () => {
  const pkg = await createPackage(on, { menuIds: [] })
  const old = `${PREFIX}old-group`
  let fresh = 0
  // the existing group steps aside (its route name and path are both unique) as if it never was
  await ds.query('UPDATE iam_menu SET route_name = ?, route_path = ? WHERE id = ?', [
    old,
    `/${old}`,
    imGroup,
  ])
  try {
    await inTenant1(() => seedIm(ds.manager))
    fresh = Number(
      (
        await ds.query<{ id: number }[]>(
          "SELECT id FROM iam_menu WHERE route_name = 'im' AND deleted_at IS NULL",
        )
      )[0]!.id,
    )
    expect(fresh).not.toBe(imGroup)
    const holds = async (packageId: number) =>
      (
        await ds.query(
          'SELECT 1 FROM iam_tenant_package_menus WHERE package_id = ? AND menu_id = ? AND deleted_at IS NULL',
          [packageId, fresh],
        )
      ).length === 1
    expect(await holds(pkg.id)).toBe(true)
    expect(await holds(noImPackage.id)).toBe(true)
    await ds.query('DELETE FROM iam_tenant_package_menus WHERE package_id = ? AND menu_id = ?', [
      pkg.id,
      fresh,
    ])
    await inTenant1(() => seedIm(ds.manager))
    expect(await holds(pkg.id)).toBe(false)
  } finally {
    if (fresh) {
      await ds.query('DELETE FROM iam_tenant_package_menus WHERE menu_id = ?', [fresh])
      await ds.query('DELETE FROM iam_menu WHERE id = ?', [fresh])
    }
    await ds.query("UPDATE iam_menu SET route_name = 'im', route_path = '/im' WHERE id = ?", [
      imGroup,
    ])
    await pkg.dispose()
  }
})

it('the chat tables are never importable by the code generator', async () => {
  const root = (await signIn(on)).accessToken
  const res = await get(on, '/api/codegen/tables/importable', root).expect(200)
  const names = (res.body.data as { tableName: string }[]).map((t) => t.tableName)
  expect(names).toContain('iam_role')
  expect(names.filter((n) => n.startsWith('im_'))).toEqual([])
  const refused = await request(on.getHttpServer())
    .post('/api/codegen/tables/import')
    .set(bearer(root))
    .send({ tableNames: ['im_entry'] })
    .expect(422)
  expect(refused.body.code).toBe(Err.CODEGEN_TABLE_UNAVAILABLE.code)
})
