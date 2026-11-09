// 员工聊天通讯录（see docs/im.md）：只列本租户启用、未删除的内部员工（停用、会员身份、已删除、别的租户都不
// 出现），不带手机号、邮箱与登录名；只列启用部门，用户所在部门停用时 deptId 为 null；`Cache-Control:
// private, no-cache`，带 If-None-Match 复验得 304，改名后 ETag 变。
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { bearer } from '../setup/auth.js'
import {
  addUser,
  bootApp,
  createTenant,
  type PeopledTenant,
  signInDirect,
} from '../setup/tenants.js'

const PREFIX = 'im-directory-'

let app: NestExpressApplication
let ds: DataSource
let other: PeopledTenant
const madeUsers: number[] = []
const madeDepts: number[] = []
let n = 0

interface Directory {
  depts: { id: number; parentId: number; name: string; sortNo: number }[]
  users: { id: number; displayName: string; avatarUrl: string | null; deptId: number | null }[]
}

async function person(opts: { deptId?: number } = {}): Promise<number> {
  const id = await addUser(app, 1, `${PREFIX}${++n}`, opts)
  madeUsers.push(id)
  return id
}

async function dept(name: string, enabled: boolean): Promise<number> {
  const { insertId } = await ds.query<{ insertId: number }>(
    "INSERT INTO iam_dept (parent_id, tree_path, name, enabled, tenant_id) VALUES (0, '/', ?, ?, 1)",
    [`${PREFIX}${name}`, enabled ? 1 : 0],
  )
  await ds.query('UPDATE iam_dept SET tree_path = ? WHERE id = ?', [`/${insertId}/`, insertId])
  madeDepts.push(Number(insertId))
  return Number(insertId)
}

const directory = async (token: string, etag?: string) => {
  const req = request(app.getHttpServer()).get('/api/im/directory').set(bearer(token))
  return etag ? req.set('If-None-Match', etag) : req
}

beforeAll(async () => {
  app = await bootApp({ multiTenant: true })
  ds = app.get<DataSource>(getDataSourceToken())
  other = await createTenant(app, { users: true })
})

afterAll(async () => {
  if (ds) {
    if (madeUsers.length) await ds.query('DELETE FROM iam_user WHERE id IN (?)', [madeUsers])
    if (madeDepts.length) await ds.query('DELETE FROM iam_dept WHERE id IN (?)', [madeDepts])
  }
  await other?.dispose()
  await app?.close()
})

it('lists only enabled staff of the own tenant, without contact data or user names', async () => {
  const open = await dept('open', true)
  const staff = await person({ deptId: open })
  const staffName = `${PREFIX}${n}`
  const disabled = await person()
  await ds.query('UPDATE iam_user SET enabled = 0 WHERE id = ?', [disabled])
  const member = await person()
  await ds.query("UPDATE iam_user SET user_type = 'member' WHERE id = ?", [member])
  const deleted = await person()
  await ds.query('UPDATE iam_user SET deleted_at = NOW(3) WHERE id = ?', [deleted])
  await ds.query(
    "UPDATE iam_user SET mobile = '13900001234', email = 'staff@example.com' WHERE id = ?",
    [staff],
  )

  const res = await directory((await signInDirect(app, staff))!.accessToken)
  expect(res.status).toBe(200)
  expect(res.headers['cache-control']).toBe('private, no-cache')
  const { users, depts } = res.body.data as Directory
  const ids = users.map((u) => u.id)
  expect(ids).toContain(staff)
  for (const gone of [disabled, member, deleted, other.users.admin, other.users.alice])
    expect(ids).not.toContain(gone)
  const me = users.find((u) => u.id === staff)!
  expect(me).toEqual({ id: staff, displayName: staffName, avatarUrl: null, deptId: open })
  for (const u of users)
    expect(Object.keys(u).sort()).toEqual(['avatarUrl', 'deptId', 'displayName', 'id'])
  expect(depts.find((d) => d.id === open)).toEqual({
    id: open,
    parentId: 0,
    name: `${PREFIX}open`,
    sortNo: 0,
  })
  for (const d of depts) expect(Object.keys(d).sort()).toEqual(['id', 'name', 'parentId', 'sortNo'])
  expect(JSON.stringify(res.body)).not.toContain('13900001234')
  expect(JSON.stringify(res.body)).not.toContain('staff@example.com')
})

it('leaves disabled departments out; their people stay, without a department', async () => {
  const closed = await dept('closed', false)
  const someone = await person({ deptId: closed })
  const { users, depts } = (await directory((await signInDirect(app, someone))!.accessToken)).body
    .data as Directory
  expect(depts.map((d) => d.id)).not.toContain(closed)
  expect(users.find((u) => u.id === someone)?.deptId).toBeNull()
})

it('another tenant sees only its own people', async () => {
  const mine = await person()
  const { users } = (await directory((await signInDirect(app, other.users.alice))!.accessToken))
    .body.data as Directory
  const ids = users.map((u) => u.id)
  expect(ids).toEqual(expect.arrayContaining([other.users.admin, other.users.alice]))
  expect(ids).not.toContain(mine)
  // 别的租户的根部门等只属于它自己
  const own = await ds.query<{ id: number }[]>(
    'SELECT id FROM iam_dept WHERE tenant_id = ? AND enabled = 1 AND deleted_at IS NULL',
    [other.id],
  )
  expect(
    (
      (await directory((await signInDirect(app, other.users.alice))!.accessToken)).body
        .data as Directory
    ).depts
      .map((d) => d.id)
      .sort((a, b) => a - b),
  ).toEqual(own.map((d) => Number(d.id)).sort((a, b) => a - b))
})

it('revalidates with the ETag (304) until a name changes', async () => {
  const someone = await person()
  const token = (await signInDirect(app, someone))!.accessToken
  const first = await directory(token)
  const etag = first.headers.etag as string
  expect(etag).toBeTruthy()
  const same = await directory(token, etag)
  expect(same.status).toBe(304)
  expect(same.text).toBe('')
  await ds.query("UPDATE iam_user SET display_name = 'renamed in directory' WHERE id = ?", [
    someone,
  ])
  const changed = await directory(token, etag)
  expect(changed.status).toBe(200)
  expect(changed.headers.etag).not.toBe(etag)
  expect((changed.body.data as Directory).users.find((u) => u.id === someone)?.displayName).toBe(
    'renamed in directory',
  )
})

it('a member identity gets 403', async () => {
  const member = await person()
  await ds.query("UPDATE iam_user SET user_type = 'member' WHERE id = ?", [member])
  const res = await directory((await signInDirect(app, member))!.accessToken)
  expect([res.status, res.body.code]).toEqual([403, Err.IM_STAFF_ONLY.code])
})
