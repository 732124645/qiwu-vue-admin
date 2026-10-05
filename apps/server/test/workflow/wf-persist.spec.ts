// 持久化适配 (see docs/design-notes.md#workflow): WfStore writes the engine's change sets to the wf tables of the test
// database. Covers the instance lock (FOR UPDATE), the conditional task UPDATEs (409), multi-token
// active_node_ids, from_task_id / due_at / created_at, the wf_cc de-dup, acting in a transaction
// that read before (current reads), and the WfBusinessHandler registry called in the action's transaction.
// The org chart is the engines specs' in-memory one.
import { Injectable } from '@nestjs/common'
import { DiscoveryModule } from '@nestjs/core'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { Test, type TestingModule } from '@nestjs/testing'
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm'
import { Err, type WfChangeSet, type WfStep } from '@qiwu/shared'
import { ClsService } from 'nestjs-cls'
import type { DataSource, EntityManager } from 'typeorm'
import { CoreContextModule } from '../../src/core/context/context.module.js'
import { CoreDbModule } from '../../src/core/db/db.module.js'
import { approve, reject } from '../../src/modules/workflow/engine/actions.js'
import { emptyChangeSet } from '../../src/modules/workflow/engine/advance.js'
import { cc, comment, withdraw } from '../../src/modules/workflow/engine/lifecycle.js'
import { WfBusinessHandler, WfHandlers } from '../../src/modules/workflow/runtime/wf-handlers.js'
import { WfNotify } from '../../src/modules/workflow/runtime/wf-notify.js'
import {
  WF_RUNTIME_ENTITIES,
  WfCcRow,
  WfEventRow,
  WfInstanceRow,
  WfTaskRow,
} from '../../src/modules/workflow/runtime/wf-runtime.entity.js'
import { WF_ORG, type WfRun, WfStore } from '../../src/modules/workflow/runtime/wf-store.js'
import {
  chain,
  fields,
  HOUR,
  notify,
  org,
  parallel,
  review,
  T0,
  users,
} from '../fixtures/wf/flow.js'

const CUSTOM = 'persist.custom'

/** The handler of model `persist.custom`: mirrors the instance state onto a biz_leave_request row. */
@WfBusinessHandler(CUSTOM)
@Injectable()
class MirrorHandler implements WfBusinessHandler {
  states: string[] = []
  fail = false
  fields = () => fields
  assertStartable = async () => {}
  loadFormValues = async () => ({})
  async onStateChange(inst: WfInstanceRow, tx: EntityManager) {
    this.states.push(inst.state)
    await tx.query('UPDATE biz_leave_request SET instance_id = ?, state = ? WHERE id = ?', [
      inst.id,
      inst.state,
      Number(inst.businessKey),
    ])
    if (this.fail) throw new Error('handler failed')
  }
}

let moduleRef: TestingModule
let ds: DataSource
let cls: ClsService
let store: WfStore
let mirror: MirrorHandler
let seq = 0

const conflict = { err: Err.CONFLICT }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** a model with one published version of `steps` (dynamic unless `key` says otherwise); the version id */
async function publish(steps: WfStep[], key = `persist.m${++seq}`): Promise<number> {
  const tree = { id: 'begin', type: 'begin', name: 'Begin', next: chain(...steps) }
  const m = await ds.query(
    'INSERT INTO wf_model (model_key, name, form_kind, manager_user_ids) VALUES (?, ?, ?, ?)',
    [key, key, key === CUSTOM ? 'custom' : 'dynamic', JSON.stringify([7])],
  )
  const v = await ds.query(
    'INSERT INTO wf_version (model_id, model_key, version, tree_json, form_snapshot) VALUES (?, ?, 1, ?, ?)',
    [m.insertId, key, JSON.stringify(tree), JSON.stringify({ fields })],
  )
  return v.insertId
}

const start = (versionId: number, businessKey: string | null = null, now = T0) =>
  cls.run(() =>
    store.start(
      {
        versionId,
        initiatorId: 4,
        initiatorDeptId: 3,
        businessKey,
        formValues: { amount: 1 },
        initiatorPicks: { x: [2] },
        initiatorCtx: { deptTreePath: '/1/2/3/', roleIds: [5] },
      },
      now,
    ),
  )
const act = (
  instanceId: number,
  fn: (run: WfRun) => WfChangeSet | Promise<WfChangeSet>,
  now = T0,
) => cls.run({ ifNested: 'override' }, () => store.act(instanceId, fn, now)) // own transaction, nested too
/** the open task of `userId` in `run` */
const taskOf = (run: WfRun, userId: number) =>
  run.tasks.find((t) => t.assigneeId === userId && t.state === 'pending')!
/** `userId` approves their pending task */
const approveBy = (instanceId: number, userId: number, now = T0) =>
  act(instanceId, (r) => approve(r.ctx, r.inst, r.tasks, taskOf(r, userId), { comment: null }), now)

const instanceRow = (id: number) => ds.getRepository(WfInstanceRow).findOneByOrFail({ id })
const tasksOf = (instanceId: number) =>
  ds.getRepository(WfTaskRow).find({ where: { instanceId }, order: { id: 'ASC' } })
const ccsOf = (instanceId: number) =>
  ds.getRepository(WfCcRow).find({ where: { instanceId }, order: { id: 'ASC' } })
const eventsOf = (instanceId: number) =>
  ds.getRepository(WfEventRow).find({ where: { instanceId }, order: { id: 'ASC' } })
/** every wf row of an instance, to show an action left nothing behind */
const snapshot = async (instanceId: number) => ({
  inst: await instanceRow(instanceId),
  tasks: await tasksOf(instanceId),
  ccs: await ccsOf(instanceId),
  events: await eventsOf(instanceId),
})

async function clean() {
  const sub = "SELECT id FROM wf_instance WHERE model_key LIKE 'persist.%'"
  for (const t of ['wf_task', 'wf_cc', 'wf_event'])
    await ds.query(`DELETE FROM ${t} WHERE instance_id IN (${sub})`)
  for (const t of ['wf_instance', 'wf_version', 'wf_model'])
    await ds.query(`DELETE FROM ${t} WHERE model_key LIKE 'persist.%'`)
  await ds.query("DELETE FROM biz_leave_request WHERE reason = 'wf-persist'")
}

beforeAll(async () => {
  moduleRef = await Test.createTestingModule({
    imports: [
      CoreContextModule,
      CoreDbModule,
      DiscoveryModule,
      TypeOrmModule.forFeature(WF_RUNTIME_ENTITIES),
    ],
    providers: [
      WfHandlers,
      WfStore,
      { provide: WF_ORG, useValue: org },
      // notifications are wf-notify's (they need the app's Notifier)
      { provide: WfNotify, useValue: { changed: async () => {} } },
      MirrorHandler,
    ],
  }).compile()
  await moduleRef.init()
  ds = moduleRef.get(getDataSourceToken())
  cls = moduleRef.get(ClsService)
  store = moduleRef.get(WfStore)
  mirror = moduleRef.get(MirrorHandler)
  await clean()
})

afterAll(async () => {
  if (ds?.isInitialized) await clean()
  await moduleRef?.close()
})

describe('writing change sets', () => {
  it('start: the instance, its first tasks (due_at, from_task_id, created_at = action time), ccs, events', async () => {
    const v = await publish([
      notify('n', 7, 8),
      review('a', { ...users(2), timeout: { hours: 2 } }),
    ])
    const done = await start(v)
    const { inst, tasks, ccs, events } = await snapshot(done.inst.id)
    expect(inst).toMatchObject({
      versionId: v,
      businessKey: null,
      initiatorId: 4,
      initiatorDeptId: 3,
      state: 'running',
      formValues: { amount: 1 },
      initiatorPicks: { x: [2] },
      initiatorCtx: { deptTreePath: '/1/2/3/', roleIds: [5] },
      activeNodeIds: ['a'],
      startedAt: T0,
      endedAt: null,
    })
    expect(inst.modelKey).toMatch(/^persist\.m\d+$/)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      id: done.taskIds[0],
      nodeId: 'a',
      nodeName: 'A',
      assigneeId: 2,
      ownerId: null,
      parentTaskId: null,
      fromTaskId: null,
      signKind: null,
      seq: 0,
      state: 'pending',
      dueAt: new Date(T0.getTime() + 2 * HOUR),
      createdAt: T0,
      handledAt: null,
    })
    expect(ccs.map((c) => [c.nodeId, c.userId, c.fromTaskId, c.fromUserId])).toEqual([
      ['n', 7, null, null],
      ['n', 8, null, null],
    ])
    expect(done.ccs).toHaveLength(2)
    expect(events.map((e) => [e.action, e.nodeId, e.actorId, e.targetIds])).toEqual([
      ['begin', 'begin', 4, null],
      ['cc', 'n', null, [7, 8]],
    ])
  })

  it('multi-token: a node per parallel path in active_node_ids, the join after the last path', async () => {
    const v = await publish([
      review('a'),
      parallel('p', [review('b', users(3)), review('c', users(5))]),
      review('d', users(1)),
    ])
    const id = (await start(v)).inst.id
    const [a] = await tasksOf(id)
    await approveBy(id, 2)
    expect((await instanceRow(id)).activeNodeIds.sort()).toEqual(['b', 'c'])
    const open = (await tasksOf(id)).filter((t) => t.state === 'pending')
    expect(open.map((t) => [t.nodeId, t.fromTaskId])).toEqual([
      ['b', a!.id],
      ['c', a!.id],
    ])
    await approveBy(id, 3)
    expect((await instanceRow(id)).activeNodeIds).toEqual(['c'])
    const joined = await approveBy(id, 5)
    const tasks = await tasksOf(id)
    const d = tasks.find((t) => t.nodeId === 'd')!
    expect((await instanceRow(id)).activeNodeIds).toEqual(['d'])
    expect(joined.taskIds).toEqual([d.id])
    expect(d.fromTaskId).toBe(tasks.find((t) => t.nodeId === 'c')!.id)
  })

  it('ordered: a waiting reviewer has no due_at until their turn; the patch writes it from then', async () => {
    const v = await publish([
      review('o', { ...users(2, 3), sign: 'ordered', timeout: { hours: 1 } }),
    ])
    const id = (await start(v)).inst.id
    const row = (t: WfTaskRow) => [t.assigneeId, t.seq, t.state, t.dueAt, t.handledAt]
    expect((await tasksOf(id)).map(row)).toEqual([
      [2, 0, 'pending', new Date(T0.getTime() + HOUR), null],
      [3, 1, 'waiting', null, null],
    ])
    const later = new Date(T0.getTime() + 5 * HOUR)
    await approveBy(id, 2, later)
    expect((await tasksOf(id)).map(row)).toEqual([
      [2, 0, 'approved', new Date(T0.getTime() + HOUR), later],
      [3, 1, 'pending', new Date(later.getTime() + HOUR), null],
    ])
  })

  it('an end state writes ended_at and empties active_node_ids', async () => {
    const v = await publish([review('a')])
    const id = (await start(v)).inst.id
    const end = new Date(T0.getTime() + HOUR)
    await approveBy(id, 2, end)
    expect(await instanceRow(id)).toMatchObject({
      state: 'approved',
      activeNodeIds: [],
      endedAt: end,
    })
  })
})

describe('concurrency', () => {
  /** approves task `taskId` whatever state it is in by now (as an API that did not check would) */
  const approveTask = (instanceId: number, taskId: number) =>
    act(instanceId, (r) =>
      approve(
        r.ctx,
        r.inst,
        r.tasks,
        r.tasks.find((t) => t.id === taskId)!,
        { comment: null },
      ),
    )

  it('a task patch that changes no row (the task moved on) rolls the whole action back as 409', async () => {
    const v = await publish([review('a'), review('b', users(3))])
    const id = (await start(v)).inst.id
    const [a] = await tasksOf(id)
    await approveTask(id, a!.id)
    const before = await snapshot(id)
    // the engine is handed the approved task again: its patch expects `pending`
    await expect(approveTask(id, a!.id)).rejects.toMatchObject(conflict)
    expect(await snapshot(id)).toEqual(before)
  })

  it('two concurrent approvals of one task advance once; the other is 409', async () => {
    const v = await publish([review('a'), review('b', users(3))])
    const id = (await start(v)).inst.id
    const [a] = await tasksOf(id)
    const results = await Promise.allSettled([approveTask(id, a!.id), approveTask(id, a!.id)])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: conflict })
    expect((await tasksOf(id)).filter((t) => t.nodeId === 'b')).toHaveLength(1)
    expect((await eventsOf(id)).filter((e) => e.action === 'approve')).toHaveLength(1)
  })

  it('actions on one instance run one after another (FOR UPDATE): `all` co-reviewers at once still move on', async () => {
    const v = await publish([review('a', { ...users(2, 3), sign: 'all' }), review('b', users(1))])
    const id = (await start(v)).inst.id
    let entered!: () => void
    const inside = new Promise<void>((resolve) => (entered = resolve))
    const first = act(id, async (r) => {
      const set = await approve(r.ctx, r.inst, r.tasks, taskOf(r, 2), { comment: null })
      entered()
      await sleep(300) // the second action starts meanwhile and has to wait for this one
      return set
    })
    await inside
    await Promise.all([first, approveBy(id, 3)])
    expect((await instanceRow(id)).activeNodeIds).toEqual(['b'])
    const b = (await tasksOf(id)).filter((t) => t.nodeId === 'b')
    expect(b.map((t) => [t.assigneeId, t.state])).toEqual([[1, 'pending']])
  })

  it("a patch never changes another instance's task or a deleted one (409)", async () => {
    const v = await publish([review('a')])
    const one = (await start(v)).inst.id
    const other = await start(v)
    const cancel = (taskId: number) => (): WfChangeSet => ({
      ...emptyChangeSet(),
      taskPatches: [{ id: taskId, from: 'pending', set: { state: 'canceled' } }],
    })
    await expect(act(one, cancel(other.taskIds[0]!))).rejects.toMatchObject(conflict)
    expect((await tasksOf(other.inst.id))[0]!.state).toBe('pending')
    const [mine] = await tasksOf(one)
    await ds.query('UPDATE wf_task SET deleted_at = NOW(3) WHERE id = ?', [mine!.id])
    await expect(act(one, cancel(mine!.id))).rejects.toMatchObject(conflict)
    const [raw] = await ds.query('SELECT state FROM wf_task WHERE id = ?', [mine!.id])
    expect(raw.state).toBe('pending')
  })
})

describe('wf_cc de-dup', () => {
  it('a notify node passed again from the same task (withdrawn, approved again) adds no row', async () => {
    const v = await publish([review('a'), notify('n', 7, 8), review('b', users(3))])
    const id = (await start(v)).inst.id
    const [a] = await tasksOf(id)
    expect((await approveBy(id, 2)).ccs.map((c) => c.userId)).toEqual([7, 8])
    await act(id, (r) =>
      withdraw(
        r.ctx,
        r.inst,
        r.tasks,
        r.tasks.find((t) => t.id === a!.id)!,
        {
          comment: null,
          events: r.events,
        },
      ),
    )
    const again = await approveBy(id, 2)
    expect(again.set.ccs).toHaveLength(2) // the engine passed the node again
    expect(again.ccs).toEqual([])
    expect(again.taskIds).toHaveLength(1) // b again
    expect((await ccsOf(id)).map((c) => [c.nodeId, c.userId, c.fromTaskId])).toEqual([
      ['n', 7, a!.id],
      ['n', 8, a!.id],
    ])
  })

  it('keeps one row per (node, user, from task): a new key is written, a repeat in the same set once', async () => {
    const v = await publish([review('a')])
    const id = (await start(v)).inst.id
    const [a] = await tasksOf(id)
    const cc = (userId: number, fromTaskId: number | null) => ({
      nodeId: 'a',
      userId,
      fromTaskId,
      fromUserId: 2,
      reason: null,
    })
    const write = (...ccs: ReturnType<typeof cc>[]) => act(id, () => ({ ...emptyChangeSet(), ccs }))
    expect((await write(cc(7, a!.id), cc(7, a!.id), cc(7, null))).ccs).toEqual([
      cc(7, a!.id),
      cc(7, null),
    ])
    expect((await write(cc(7, null), cc(8, a!.id))).ccs).toEqual([cc(8, a!.id)])
    expect(await ccsOf(id)).toHaveLength(3)
  })

  it('the cc read takes no gap lock: two instances writing their first ccs at once both commit', async () => {
    const v = await publish([review('a'), notify('n', 7)])
    const ids = [(await start(v)).inst.id, (await start(v)).inst.id]
    let ready = 0
    let go!: () => void
    const both = new Promise<void>((resolve) => (go = resolve))
    const approveA = (id: number) =>
      act(id, async (r) => {
        const set = await approve(r.ctx, r.inst, r.tasks, taskOf(r, 2), { comment: null })
        if (++ready === 2) go()
        await both // each holds its locks before either writes (FOR SHARE on wf_cc deadlocks here)
        return set
      })
    await Promise.all(ids.map(approveA))
    for (const id of ids) expect((await ccsOf(id)).map((c) => c.userId)).toEqual([7])
  })
})

describe('acting in a transaction that read before (its snapshot predates the instance lock)', () => {
  /** one transaction: a plain read of the instance's tasks, `meanwhile` commits another action, `fn` acts */
  const afterRead = (
    id: number,
    meanwhile: () => Promise<unknown>,
    fn: Parameters<typeof act>[1],
  ) => {
    const host = moduleRef.get<TransactionHost<TransactionalAdapterTypeOrm>>(TransactionHost)
    return cls.run(() =>
      host.withTransaction(async () => {
        await host.tx.query('SELECT id FROM wf_task WHERE instance_id = ?', [id])
        await meanwhile()
        return store.act(id, fn, T0)
      }),
    )
  }

  it('reads the tasks committed since: the last `all` co-reviewer still moves the token on', async () => {
    const v = await publish([
      review('a', { ...users(2, 3), sign: 'all' }),
      notify('n', 7),
      review('b', users(1)),
    ])
    const id = (await start(v)).inst.id
    const done = await afterRead(
      id,
      () => approveBy(id, 3),
      (r) => approve(r.ctx, r.inst, r.tasks, taskOf(r, 2), { comment: null }),
    )
    expect(done.ccs.map((c) => c.userId)).toEqual([7]) // no cc was written meanwhile: no 409
    expect((await instanceRow(id)).activeNodeIds).toEqual(['b'])
    const b = (await tasksOf(id)).filter((t) => t.nodeId === 'b')
    expect(b.map((t) => [t.assigneeId, t.state])).toEqual([[1, 'pending']])
  })

  it('reads the events committed since: a withdraw after a comment on the next task is 409', async () => {
    const v = await publish([review('a'), review('b', users(3))])
    const id = (await start(v)).inst.id
    const [a] = await tasksOf(id)
    await approveBy(id, 2)
    const withdrawA = (r: WfRun) =>
      withdraw(
        r.ctx,
        r.inst,
        r.tasks,
        r.tasks.find((t) => t.id === a!.id)!,
        {
          comment: null,
          events: r.events,
        },
      )
    const commentB = () =>
      act(id, (r) => comment(r.ctx, r.inst, r.tasks, taskOf(r, 3), { comment: 'hm' }))
    await expect(afterRead(id, commentB, withdrawA)).rejects.toMatchObject(conflict)
    expect((await tasksOf(id)).map((t) => [t.nodeId, t.state])).toEqual([
      ['a', 'approved'],
      ['b', 'pending'],
    ])
  })

  it('ccs: a snapshot that misses a cc written since is 409, so the row is not written twice', async () => {
    const v = await publish([review('a')])
    const id = (await start(v)).inst.id
    const ccTo7 = (r: WfRun) =>
      cc(r.ctx, r.inst, r.tasks, taskOf(r, 2), { userIds: [7], reason: null })
    await expect(afterRead(id, () => act(id, ccTo7), ccTo7)).rejects.toMatchObject(conflict)
    expect((await ccsOf(id)).map((c) => c.userId)).toEqual([7])
  })
})

describe('WfBusinessHandler', () => {
  let customVersion: number
  let leaveId: number
  const leave = async () =>
    (
      await ds.query(
        'SELECT instance_id AS instanceId, state FROM biz_leave_request WHERE id = ?',
        [leaveId],
      )
    )[0]

  beforeAll(async () => {
    customVersion = await publish([review('a')], CUSTOM)
  })

  beforeEach(async () => {
    const r = await ds.query(
      `INSERT INTO biz_leave_request (user_id, dept_id, leave_kind, start_at, end_at, days, reason)
       VALUES (4, 3, 'annual', ?, ?, 1, 'wf-persist')`,
      [T0, T0],
    )
    leaveId = r.insertId
    mirror.states = []
    mirror.fail = false
  })

  it('is registered per model key; a key registered twice fails the start', async () => {
    const handlers = moduleRef.get(WfHandlers)
    expect(handlers.get(CUSTOM)).toBe(mirror)
    expect(handlers.get('persist.none')).toBeUndefined()
    @WfBusinessHandler('persist.twice')
    @Injectable()
    class One {}
    @WfBusinessHandler('persist.twice')
    @Injectable()
    class Two {}
    const twice = await Test.createTestingModule({
      imports: [DiscoveryModule],
      providers: [WfHandlers, One, Two],
    }).compile()
    await expect(twice.init()).rejects.toThrow(
      "@WfBusinessHandler('persist.twice') registered twice",
    )
  })

  it('onStateChange runs in the start transaction: its throw leaves no instance and no business change', async () => {
    mirror.fail = true
    await expect(start(customVersion, String(leaveId))).rejects.toThrow('handler failed')
    expect(mirror.states).toEqual(['running'])
    expect(await leave()).toEqual({ instanceId: null, state: 'draft' })
    expect(await ds.query('SELECT id FROM wf_instance WHERE model_key = ?', [CUSTOM])).toEqual([])
  })

  it('then runs on each state change only, in the action transaction; its throw rolls the action back', async () => {
    const id = (await start(customVersion, String(leaveId))).inst.id
    expect(mirror.states).toEqual(['running'])
    expect(await leave()).toEqual({ instanceId: id, state: 'running' })
    await act(id, (r) => comment(r.ctx, r.inst, r.tasks, taskOf(r, 2), { comment: 'hm' }))
    expect(mirror.states).toEqual(['running'])
    const rejectA = () =>
      act(id, (r) => reject(r.ctx, r.inst, r.tasks, taskOf(r, 2), { comment: 'no' }))
    mirror.fail = true
    const before = await snapshot(id)
    await expect(rejectA()).rejects.toThrow('handler failed')
    expect(await snapshot(id)).toEqual(before)
    expect(await leave()).toEqual({ instanceId: id, state: 'running' })
    mirror.fail = false
    await rejectA()
    expect(mirror.states).toEqual(['running', 'rejected', 'rejected'])
    expect(await leave()).toEqual({ instanceId: id, state: 'rejected' })
    expect(await instanceRow(id)).toMatchObject({
      state: 'rejected',
      activeNodeIds: [],
      endedAt: T0,
    })
  })
})

describe('engine context', () => {
  it('an unknown instance is 404', async () => {
    await expect(act(0, () => emptyChangeSet())).rejects.toMatchObject({ err: Err.NOT_FOUND })
  })

  it('manager ids come from the live model; a deleted version still runs its instances', async () => {
    const v = await publish([review('a'), review('m', { ...users(6), whenNobody: 'toManager' })])
    const live = (await start(v)).inst.id
    const orphan = (await start(v)).inst.id
    await approveBy(live, 2)
    const m = (await tasksOf(live)).filter((t) => t.nodeId === 'm')
    expect(m.map((t) => t.assigneeId)).toEqual([7])
    await ds.query(
      `UPDATE wf_model m JOIN wf_version v ON v.model_id = m.id
          SET m.deleted_at = NOW(3), v.deleted_at = NOW(3) WHERE v.id = ?`,
      [v],
    )
    // the version still loads (else 404) and nobody manages a deleted model
    await expect(approveBy(orphan, 2)).rejects.toMatchObject({ err: Err.WF_NO_ASSIGNEE })
  })
})
