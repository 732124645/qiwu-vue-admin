// The leave requests and the demo pages with tenants (see docs/design-notes.md#tenancy), the switch on,
// between the default tenant (A) and tenant B. A leave request of B runs B's own process (reviewed by
// B's tenant_admin) and stays in B with its instance and task; another tenant's request is out of every
// list and 404 to get and edit, also when it names the caller's id, and nothing of it changes. A
// sent-back request is editable on a pending begin task of the caller's tenant only (its task, instance
// and version). The demo realtime page reaches users and role members of the sender's tenant only (a
// role or role link of another tenant makes no member). A demo book cannot point at another tenant's
// dept (404, nothing written). The generated CRUD pages' isolation is covered by their generated specs.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import {
  DEFAULT_TENANT_ID as DEFAULT_TENANT,
  demoRealtimePerms,
  Err,
  leavePerms,
  type RealtimeMessage,
  RT,
} from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { findId } from '../../src/db/seeds/upsert.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import { closeSockets, connect, inbox, socketOf } from '../setup/socket.js'
import {
  addRow,
  bootApp,
  createTenant,
  inTenant1,
  type PeopledTenant,
  signInDirect,
} from '../setup/tenants.js'

const PREFIX = 'tbiz-'

let on: NestExpressApplication
let ds: DataSource
let redis: Redis
let B: PeopledTenant
/** the default tenant's root */
let rootId = 0
const tokens = { root: '', bOwner: '', bAdmin: '', bAlice: '' }
/** the default tenant's rows of this spec, by table (B's go with B.dispose()) */
const mine = {
  biz_leave_request: [] as number[],
  wf_task: [] as number[],
  wf_instance: [] as number[],
  wf_version: [] as number[],
  iam_role: [] as number[],
}

type Who = keyof typeof tokens
const http = (who: Who, method: 'get' | 'post' | 'put', path: string, body?: object) => {
  const req = request(on.getHttpServer())[method](`/api${path}`).set(bearer(tokens[who]))
  return body ? req.send(body) : req
}
const expect404 = (res: request.Response) => {
  expect(res.status).toBe(404)
  expect(res.body.code).toBe(Err.NOT_FOUND.code)
}

/** A row of the default tenant (tracked for cleanup). */
async function inA(table: keyof typeof mine, row: Record<string, unknown>) {
  const id = await addRow(on, DEFAULT_TENANT, table, row)
  mine[table].push(id)
  return id
}

let seq = 0
const leave = (days = 3) => ({
  leaveKind: 'annual',
  startAt: '2026-10-08T01:00:00.000Z',
  endAt: '2026-10-10T10:00:00.000Z',
  days,
  reason: `${PREFIX}${++seq}`,
})
/** A leave row written straight to the table (a draft unless told otherwise). */
const leaveRow = (userId: number, extra: object = {}) => ({
  user_id: userId,
  leave_kind: 'annual',
  start_at: new Date('2026-10-08T01:00:00Z'),
  end_at: new Date('2026-10-10T10:00:00Z'),
  days: 3,
  reason: `${PREFIX}${++seq}`,
  ...extra,
})
/** What is stored (raw SQL: no tenant condition). */
const stored = (id: number) =>
  ds.query<Record<string, unknown>[]>(
    'SELECT tenant_id, user_id, days, state, instance_id, reason FROM biz_leave_request WHERE id = ?',
    [id],
  )
const instanceOf = async (id: number) =>
  (
    await ds.query<{ tenant_id: number; version_id: number; state: string }[]>(
      'SELECT tenant_id, version_id, state FROM wf_instance WHERE id = ?',
      [id],
    )
  )[0]!
const openTasks = (instanceId: number) =>
  ds.query<{ id: number; tenant_id: number; node_id: string; assignee_id: number }[]>(
    `SELECT id, tenant_id, node_id, assignee_id FROM wf_task
      WHERE instance_id = ? AND state = 'pending' AND deleted_at IS NULL ORDER BY id`,
    [instanceId],
  )
/** B's alice submits through the API: the row as POST answers it. */
const submitInB = async (days = 3) =>
  (await http('bAlice', 'post', '/biz/leaves', leave(days)).expect(201)).body.data as {
    id: number
    instanceId: number
  }

beforeAll(async () => {
  on = await bootApp({ multiTenant: true })
  ds = on.get<DataSource>(getDataSourceToken())
  redis = on.get(REDIS)
  await cleanRedis(redis)
  B = await createTenant(on, { users: true })
  // B's role files leave requests and pushes on the demo page
  for (const perm of [
    leavePerms.browse,
    leavePerms.create,
    leavePerms.modify,
    demoRealtimePerms.send,
  ])
    await ds.query('INSERT INTO iam_role_menus (role_id, menu_id, tenant_id) VALUES (?, ?, ?)', [
      B.roleId,
      await findId(ds.manager, 'iam_menu', { perms: perm }),
      B.id,
    ])
  rootId = (await inTenant1(() => findId(ds.manager, 'iam_user', { username: 'admin' })))!
  tokens.root = (await signIn(on)).accessToken
  tokens.bOwner = (await signInDirect(on, B.ownerId))!.accessToken
  tokens.bAdmin = (await signInDirect(on, B.users.admin))!.accessToken
  tokens.bAlice = (await signInDirect(on, B.users.alice))!.accessToken
})

afterAll(async () => {
  closeSockets()
  if (ds) {
    await B?.dispose()
    if (B)
      await ds.query('DELETE FROM iam_user_roles WHERE tenant_id = ? AND user_id = ?', [
        DEFAULT_TENANT,
        B.users.alice,
      ])
    await ds.query('DELETE FROM demo_book WHERE isbn LIKE ?', [`${PREFIX}%`])
    for (const [table, ids] of Object.entries(mine))
      if (ids.length) await ds.query(`DELETE FROM ${table} WHERE id IN (?)`, [ids])
  }
  if (redis) await cleanRedis(redis)
  await on?.close()
})

describe('leave requests', () => {
  /** B's request of alice, through the API */
  let bRow: { id: number; instanceId: number }
  /** a default-tenant draft naming B's alice */
  let aStray = 0
  /** a B draft naming the default tenant's root */
  let bStray = 0

  beforeAll(async () => {
    aStray = await inA('biz_leave_request', leaveRow(B.users.alice))
    bStray = await addRow(on, B.id, 'biz_leave_request', leaveRow(rootId))
  })

  it('a submit in B runs B’s process: row, instance and task in B, the task B’s tenant_admin’s (a tenantId in the body changes nothing)', async () => {
    const res = await http('bAlice', 'post', '/biz/leaves', {
      ...leave(),
      tenantId: DEFAULT_TENANT,
    }).expect(201)
    bRow = res.body.data
    expect(res.body.data).toMatchObject({ userId: B.users.alice, state: 'in_review' })
    expect(await stored(bRow.id)).toMatchObject([{ tenant_id: B.id, state: 'in_review' }])
    const inst = await instanceOf(bRow.instanceId)
    expect(inst).toMatchObject({ tenant_id: B.id, state: 'running' })
    const [version] = await ds.query<{ tenant_id: number; model_key: string }[]>(
      'SELECT tenant_id, model_key FROM wf_version WHERE id = ?',
      [inst.version_id],
    )
    expect(version).toEqual({ tenant_id: B.id, model_key: 'leave' })
    expect(await openTasks(bRow.instanceId)).toEqual([
      expect.objectContaining({ tenant_id: B.id, assignee_id: B.ownerId }),
    ])
  })

  it('the list holds the caller’s tenant’s rows only, not another tenant’s naming the caller', async () => {
    const list = async (who: Who) =>
      (
        (await http(who, 'get', '/biz/leaves').query({ pageSize: 100 }).expect(200)).body.data
          .items as { id: number }[]
      ).map((r) => r.id)
    const b = await list('bAlice')
    expect(b).toContain(bRow.id)
    expect(b).not.toContain(aStray)
    const a = await list('root')
    expect(a).not.toContain(bStray)
    expect(a).not.toContain(bRow.id)
  })

  it('another tenant’s request is 404 to get and edit, also for its namesake owner and root; nothing changes', async () => {
    const before = [await stored(aStray), await stored(bStray), await stored(bRow.id)]
    const cases: [Who, number][] = [
      ['bAlice', aStray],
      ['root', bStray],
      ['root', bRow.id],
    ]
    for (const [who, id] of cases) {
      expect404(await http(who, 'get', `/biz/leaves/${id}`))
      expect404(await http(who, 'put', `/biz/leaves/${id}`, { days: 9, reason: 'taken over' }))
    }
    expect([await stored(aStray), await stored(bStray), await stored(bRow.id)]).toEqual(before)
    // B's approver opens B's request
    await http('bOwner', 'get', `/biz/leaves/${bRow.id}`).expect(200)
  })

  it('sent back in B, its owner edits it; a pending begin task, instance or version of another tenant is no send-back (409)', async () => {
    const [review] = await openTasks(bRow.instanceId)
    await http('bOwner', 'post', `/wf/tasks/${review!.id}/send-back`, { to: 'begin' }).expect(200)
    await http('bAlice', 'put', `/biz/leaves/${bRow.id}`, { days: 2 }).expect(200)
    expect(await stored(bRow.id)).toMatchObject([{ days: '2.0', state: 'in_review' }])

    const pendingBegin = (instanceId: number) => ({
      instance_id: instanceId,
      node_id: 'begin',
      node_name: 'begin',
      assignee_id: B.users.alice,
      state: 'pending',
    })
    const instance = (versionId: number) => ({
      version_id: versionId,
      model_key: 'leave',
      initiator_id: B.users.alice,
      form_values: {},
      initiator_picks: {},
      initiator_ctx: {},
      active_node_ids: ['begin'],
    })
    const put = (id: number) => http('bAlice', 'put', `/biz/leaves/${id}`, { days: 4 }).expect(409)

    // the task in the default tenant, on B's instance
    const viaTask = await submitInB()
    await inA('wf_task', pendingBegin(viaTask.instanceId))
    await put(viaTask.id)

    // the instance in the default tenant, on B's version, with B's task
    const bVersion = (await instanceOf(viaTask.instanceId)).version_id
    const aInstance = await inA('wf_instance', instance(bVersion))
    await addRow(on, B.id, 'wf_task', pendingBegin(aInstance))
    const viaInstance = await addRow(
      on,
      B.id,
      'biz_leave_request',
      leaveRow(B.users.alice, { state: 'in_review', instance_id: aInstance }),
    )
    await put(viaInstance)

    // the version in the default tenant, under B's instance and task
    const aVersion = await inA('wf_version', {
      model_id: 0,
      model_key: `${PREFIX}model`,
      version: 1,
      tree_json: { id: 'begin', type: 'begin', name: 'begin' },
      form_snapshot: { fields: {} },
    })
    const bInstance = await addRow(on, B.id, 'wf_instance', instance(aVersion))
    await addRow(on, B.id, 'wf_task', pendingBegin(bInstance))
    const viaVersion = await addRow(
      on,
      B.id,
      'biz_leave_request',
      leaveRow(B.users.alice, { state: 'in_review', instance_id: bInstance }),
    )
    await put(viaVersion)

    for (const id of [viaTask.id, viaInstance, viaVersion])
      expect(await stored(id)).toMatchObject([{ days: '3.0', state: 'in_review' }])
  })
})

describe('demo realtime page', () => {
  /** what the default tenant's root and B's alice receive */
  let aGot: RealtimeMessage[]
  let bGot: RealtimeMessage[]
  const settle = () => new Promise((r) => setTimeout(r, 200))
  const heard = (got: RealtimeMessage[], text: string) =>
    got.some((m) => m.type === RT.demoMessage && m.payload.text === text)
  /** sends `text` to the target; answers `delivered` */
  const send = async (who: Who, target: 'user' | 'role', ids: number[], text: string) =>
    (
      await http(who, 'post', '/demo/realtime/send', {
        target,
        [target === 'user' ? 'userIds' : 'roleIds']: ids,
        text,
      }).expect(200)
    ).body.data.delivered as number

  beforeAll(async () => {
    aGot = inbox(await connect(socketOf(on, { token: tokens.root })))
    bGot = inbox(await connect(socketOf(on, { token: tokens.bAlice })))
  })

  it('users and roles of another tenant reach no one; the sender’s own role reaches its members', async () => {
    const aRole = await inA('iam_role', {
      code: `${PREFIX}role`,
      name: `${PREFIX}role`,
      data_scope: 'own_dept',
    })
    expect(await send('bAdmin', 'user', [rootId], `${PREFIX}b-user`)).toBe(0)
    expect(await send('bAdmin', 'role', [aRole], `${PREFIX}b-role`)).toBe(0)
    expect(await send('root', 'user', [B.users.alice], `${PREFIX}a-user`)).toBe(0)
    expect(await send('root', 'role', [B.roleId], `${PREFIX}a-role`)).toBe(0)
    expect(await send('bAdmin', 'role', [B.roleId], `${PREFIX}own`)).toBe(1)
    await vi.waitFor(() => expect(heard(bGot, `${PREFIX}own`)).toBe(true))
    await settle()
    for (const text of ['b-user', 'b-role', 'a-user', 'a-role']) {
      expect(heard(aGot, PREFIX + text)).toBe(false)
      expect(heard(bGot, PREFIX + text)).toBe(false)
    }
  })

  it('a role link or a role of another tenant makes no member', async () => {
    // B's role nobody in B holds; a link of the default tenant gives it to B's alice
    const lonely = await addRow(on, B.id, 'iam_role', {
      code: `${PREFIX}lonely`,
      name: `${PREFIX}lonely`,
      data_scope: 'own_dept',
    })
    await addRow(on, DEFAULT_TENANT, 'iam_user_roles', {
      user_id: B.users.alice,
      role_id: lonely,
    })
    expect(await send('bAdmin', 'role', [lonely], `${PREFIX}link`)).toBe(0)
    // a link of B gives B's alice a role of the default tenant
    const aRole = await inA('iam_role', {
      code: `${PREFIX}foreign`,
      name: `${PREFIX}foreign`,
      data_scope: 'own_dept',
    })
    await addRow(on, B.id, 'iam_user_roles', { user_id: B.users.alice, role_id: aRole })
    expect(await send('bAdmin', 'role', [aRole], `${PREFIX}role-row`)).toBe(0)
    await settle()
    expect(heard(bGot, `${PREFIX}link`)).toBe(false)
    expect(heard(bGot, `${PREFIX}role-row`)).toBe(false)
  })
})

describe('demo books', () => {
  const books = (isbn: string) =>
    ds.query('SELECT tenant_id, dept_id FROM demo_book WHERE isbn = ?', [isbn])
  const book = (isbn: string, deptId: number | null) => ({
    isbn,
    title: isbn,
    publishedOn: '2024-05-01',
    price: 1,
    genre: 'fiction',
    deptId,
  })

  it('a book in another tenant’s dept is 404, for root too: nothing written, the row unchanged', async () => {
    expect404(await http('root', 'post', '/demo/books', book(`${PREFIX}c`, B.deptId)))
    expect(await books(`${PREFIX}c`)).toEqual([])
    const { id } = (await http('root', 'post', '/demo/books', book(`${PREFIX}u`, null)).expect(201))
      .body.data
    expect404(await http('root', 'put', `/demo/books/${id}`, { deptId: B.deptId }))
    expect(await books(`${PREFIX}u`)).toEqual([{ tenant_id: DEFAULT_TENANT, dept_id: null }])
  })
})
