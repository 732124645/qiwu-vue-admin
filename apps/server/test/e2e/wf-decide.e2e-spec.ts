// wf decisions (通过/驳回/退回/重新提交; see docs/design-notes.md#workflow): POST /wf/tasks/:id/{approve,
// reject,send-back,resubmit} and GET /wf/tasks/:id/back-targets. Sign-in only; a task the caller does not
// hold is 404 (a `wf.task.manage` admin too), one no longer pending 409. `commentRequired` steps: approve /
// reject without a comment → 422. Field access holds for dynamic forms (edit fields kept and checked, the
// rest dropped); a custom form's resubmit reads its business row again. Instances start through
// WfStartService.
import { Injectable } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, type WfFields, type WfStep } from '@qiwu/shared'
import { ClsService } from 'nestjs-cls'
import request from 'supertest'
import type { DataSource, EntityManager } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { BizError } from '../../src/core/http/biz-error.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { WfStartService } from '../../src/modules/workflow/center/wf-start.service.js'
import { WfBusinessHandler } from '../../src/modules/workflow/runtime/wf-handlers.js'
import type { WfInstanceRow } from '../../src/modules/workflow/runtime/wf-runtime.entity.js'
import { chain, parallel, review } from '../fixtures/wf/flow.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'e2e-wfd-'
const LEAVE = `${PREFIX}leave`
const REASON = 'wf-decide-e2e'

/** The custom test model's handler: the leave request's days are the form, its state follows the instance. */
@WfBusinessHandler(LEAVE)
@Injectable()
class LeaveHandler implements WfBusinessHandler {
  /** onStateChange throws when the instance reaches this state (the rollback test) */
  failOn: string | null = null

  fields = (): WfFields => ({ days: 'number' })

  async assertStartable(key: string, initiatorId: number, tx: EntityManager) {
    const [row] = await tx.query<{ user_id: number; state: string }[]>(
      'SELECT user_id, state FROM biz_leave_request WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
      [Number(key)],
    )
    if (!row || Number(row.user_id) !== initiatorId) throw new BizError(Err.NOT_FOUND)
    if (row.state !== 'draft') throw new BizError(Err.CONFLICT)
  }

  async loadFormValues(key: string, tx: EntityManager) {
    const [row] = await tx.query<{ days: string }[]>(
      'SELECT days FROM biz_leave_request WHERE id = ? AND deleted_at IS NULL',
      [Number(key)],
    )
    return { days: Number(row!.days) }
  }

  async onStateChange(inst: WfInstanceRow, tx: EntityManager) {
    if (inst.state === this.failOn) throw new Error('business handler failed')
    await tx.query(
      'UPDATE biz_leave_request SET instance_id = ?, state = ? WHERE id = ? AND deleted_at IS NULL',
      [inst.id, inst.state === 'running' ? 'in_review' : inst.state, Number(inst.businessKey)],
    )
  }
}

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let cls: ClsService
let starts: WfStartService
let handler: LeaveHandler
const tokens: Record<string, string> = {}
const u: Record<string, number> = {}
const made = { iam_user: [] as number[], iam_dept: [] as number[] }
let seq = 0

type Who = 'alice' | 'bob' | 'carol' | 'erin' | 'frank' | 'admin'
type Action = 'approve' | 'reject' | 'send-back' | 'resubmit'
const act = (who: Who, taskId: number, action: Action, body: object = {}) =>
  request(app.getHttpServer())
    .post(`/api/wf/tasks/${taskId}/${action}`)
    .set(bearer(tokens[who]!))
    .send(body)
const targetsOf = (who: Who, taskId: number) =>
  request(app.getHttpServer()).get(`/api/wf/tasks/${taskId}/back-targets`).set(bearer(tokens[who]!))

/** a review step of `who` (`any` unless several), autoPass, onReject finish */
const step = (id: string, who: Who[], extra: Partial<Extract<WfStep, { type: 'review' }>> = {}) =>
  review(id, {
    name: `${id} step`,
    assignee: { kind: 'users', ids: who.map((w) => u[w]!) },
    ...extra,
  })

interface ModelOpts {
  custom?: boolean
  fields?: WfFields
  /** `begin.access` */
  access?: Record<string, 'edit' | 'read' | 'hide'>
}

/** A model with one published version of begin → `steps`; its key. */
async function model(steps: WfStep[], opts: ModelOpts = {}): Promise<string> {
  const key = opts.custom ? LEAVE : `${PREFIX}m${++seq}`
  const root = {
    id: 'begin',
    type: 'begin',
    name: 'Begin',
    access: opts.access,
    next: chain(...steps),
  }
  const m = await ds.query('INSERT INTO wf_model (model_key, name, form_kind) VALUES (?, ?, ?)', [
    key,
    key,
    opts.custom ? 'custom' : 'dynamic',
  ])
  const fields = opts.fields ?? (opts.custom ? { days: 'number' } : {})
  const v = await ds.query(
    `INSERT INTO wf_version (model_id, model_key, version, tree_json, form_snapshot)
     VALUES (?, ?, 1, ?, ?)`,
    [m.insertId, key, JSON.stringify(root), JSON.stringify({ fields })],
  )
  await ds.query('UPDATE wf_model SET current_version_id = ? WHERE id = ?', [
    v.insertId,
    m.insertId,
  ])
  return key
}

/** alice starts `modelKey` through the start service; the instance id */
async function begin(
  modelKey: string,
  extra: { formValues?: Record<string, unknown>; businessKey?: string } = {},
) {
  const { inst } = await cls.run(() =>
    starts.start(u.alice!, { formValues: {}, initiatorPicks: {}, ...extra, modelKey }),
  )
  return inst.id
}

/** the pending task of `who` in instance `id` */
async function taskOf(id: number, who: Who): Promise<number> {
  const [row] = await ds.query<{ id: number }[]>(
    `SELECT id FROM wf_task WHERE instance_id = ? AND assignee_id = ? AND state = 'pending'
        AND deleted_at IS NULL`,
    [id, u[who]],
  )
  if (!row) throw new Error(`${who} has no pending task in instance ${id}`)
  return row.id
}

/** [node, assignee name] of the pending tasks, in creation order */
async function pending(id: number) {
  const rows = await ds.query<{ node_id: string; assignee_id: number }[]>(
    `SELECT node_id, assignee_id FROM wf_task WHERE instance_id = ? AND state = 'pending'
        AND deleted_at IS NULL ORDER BY id`,
    [id],
  )
  return rows.map((r) => [r.node_id, Object.keys(u).find((k) => u[k] === r.assignee_id)])
}

const taskRow = async (id: number) =>
  (
    await ds.query<{ state: string; comment: string | null }[]>(
      'SELECT state, comment FROM wf_task WHERE id = ? AND deleted_at IS NULL',
      [id],
    )
  )[0]
const instanceRow = async (id: number) =>
  (
    await ds.query<{ state: string; form_values: object; active_node_ids: string[] }[]>(
      `SELECT state, form_values, active_node_ids FROM wf_instance WHERE id = ? AND deleted_at IS NULL`,
      [id],
    )
  )[0]
const eventCount = async (id: number, action: string) =>
  (await ds.query('SELECT id FROM wf_event WHERE instance_id = ? AND action = ?', [id, action]))
    .length

async function user(name: string, dept: number) {
  u[name] = await insertRow(ds.manager, 'iam_user', {
    username: PREFIX + name,
    display_name: name,
    dept_id: dept,
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
  })
  made.iam_user.push(u[name])
}

async function cleanup() {
  const sub = `SELECT id FROM wf_instance WHERE model_key LIKE '${PREFIX}%'`
  for (const t of ['wf_task', 'wf_cc', 'wf_event'])
    await ds.query(`DELETE FROM ${t} WHERE instance_id IN (${sub})`)
  for (const t of ['wf_instance', 'wf_version', 'wf_model'])
    await ds.query(`DELETE FROM ${t} WHERE model_key LIKE ?`, [`${PREFIX}%`])
  await ds.query('DELETE FROM biz_leave_request WHERE reason = ?', [REASON])
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    providers: [LeaveHandler],
  }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  cls = app.get(ClsService)
  starts = app.get(WfStartService)
  handler = app.get(LeaveHandler)
  await cleanRedis(redis)
  await cleanup()
  const dept = await insertRow(ds.manager, 'iam_dept', {
    parent_id: 0,
    name: `${PREFIX}dept`,
    tree_path: '/',
  })
  made.iam_dept.push(dept)
  await ds.query('UPDATE iam_dept SET tree_path = ? WHERE id = ?', [`/${dept}/`, dept])
  for (const name of ['alice', 'bob', 'carol', 'erin', 'frank']) await user(name, dept)
  for (const who of Object.keys(u)) tokens[who] = (await signIn(app, PREFIX + who)).accessToken
  tokens.admin = (await signIn(app)).accessToken
})

afterAll(async () => {
  if (ds) {
    await cleanup()
    for (const t of ['iam_user', 'iam_dept'] as const)
      if (made[t].length) await ds.query(`DELETE FROM ${t} WHERE id IN (?)`, [made[t]])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('holder only', () => {
  it('the holder approves step by step until the instance is approved; sign-in only', async () => {
    const id = await begin(await model([step('r1', ['bob']), step('r2', ['carol'])]))
    const t1 = await taskOf(id, 'bob')
    await request(app.getHttpServer()).post(`/api/wf/tasks/${t1}/approve`).send({}).expect(401)
    await request(app.getHttpServer()).get(`/api/wf/tasks/${t1}/back-targets`).expect(401)
    await act('bob', t1, 'approve', { comment: ' fine ' }).expect(200)
    expect(await taskRow(t1)).toEqual({ state: 'approved', comment: 'fine' })
    expect(await pending(id)).toEqual([['r2', 'carol']])
    await act('carol', await taskOf(id, 'carol'), 'approve').expect(200)
    expect(await instanceRow(id)).toMatchObject({ state: 'approved', active_node_ids: [] })
  })

  it("another user's task id → 404 for every action (a wf.task.manage admin too); unknown → 404", async () => {
    const id = await begin(await model([step('r1', ['bob'], { onReject: 'sendBack' })]))
    const t1 = await taskOf(id, 'bob')
    for (const who of ['carol', 'alice', 'admin'] as const) {
      await act(who, t1, 'approve').expect(404)
      await act(who, t1, 'reject').expect(404)
      await act(who, t1, 'send-back', { to: 'begin' }).expect(404)
      await act(who, t1, 'resubmit').expect(404)
      await targetsOf(who, t1).expect(404)
    }
    await act('bob', 999_999_999, 'approve').expect(404)
    await targetsOf('bob', 999_999_999).expect(404)
    expect(await taskRow(t1)).toEqual({ state: 'pending', comment: null })
    expect(await eventCount(id, 'approve')).toBe(0)
  })

  it('a task no longer pending → 409; a begin task is not approved, a review task not resubmitted → 422', async () => {
    const id = await begin(await model([step('r1', ['bob']), step('r2', ['carol'])]))
    const t1 = await taskOf(id, 'bob')
    await act('bob', t1, 'resubmit').expect(422)
    await act('bob', t1, 'approve').expect(200)
    await act('bob', t1, 'approve').expect(409)
    await act('bob', t1, 'reject').expect(409)
    await act('bob', t1, 'send-back', { to: 'begin' }).expect(409)
    await act('carol', await taskOf(id, 'carol'), 'send-back', { to: 'begin' }).expect(200)
    const b = await taskOf(id, 'alice')
    await act('alice', b, 'approve').expect(422)
    await targetsOf('alice', b).expect(422)
  })

  it('two concurrent approvals of an any step move on once: the other 409', async () => {
    const id = await begin(await model([step('r1', ['bob', 'carol']), step('r2', ['erin'])]))
    const [tb, tc] = [await taskOf(id, 'bob'), await taskOf(id, 'carol')]
    const res = await Promise.all([act('bob', tb, 'approve'), act('carol', tc, 'approve')])
    expect(res.map((r) => r.status).sort()).toEqual([200, 409])
    expect(await pending(id)).toEqual([['r2', 'erin']])
    expect(await eventCount(id, 'approve')).toBe(1)
  })
})

describe('commentRequired', () => {
  it('approve / reject without a comment (or a blank one) → 422; send-back takes none', async () => {
    const key = await model([step('r1', ['bob'], { commentRequired: true })])
    const id = await begin(key)
    const t1 = await taskOf(id, 'bob')
    for (const [action, body] of [
      ['approve', {}],
      ['approve', { comment: '   ' }],
      ['reject', {}],
      ['reject', { comment: '' }],
    ] as const) {
      const res = await act('bob', t1, action, body).expect(422)
      expect(res.body.code).toBe(Err.WF_COMMENT_REQUIRED.code)
    }
    expect(await taskRow(t1)).toEqual({ state: 'pending', comment: null })
    await act('bob', t1, 'send-back', { to: 'begin' }).expect(200)

    const ok = await begin(key)
    await act('bob', await taskOf(ok, 'bob'), 'approve', { comment: 'ok' }).expect(200)
    expect((await instanceRow(ok))!.state).toBe('approved')
    const no = await begin(key)
    await act('bob', await taskOf(no, 'bob'), 'reject', { comment: 'no' }).expect(200)
    expect((await instanceRow(no))!.state).toBe('rejected')
  })
})

describe('field access (dynamic form)', () => {
  const fields: WfFields = { amount: 'number', note: 'string' }

  it("approve keeps the step's edit fields (checked: 400 at formValues.<field>) and drops the rest", async () => {
    const key = await model(
      [step('r1', ['bob'], { access: { amount: 'edit', note: 'read' } }), step('r2', ['carol'])],
      { fields },
    )
    const id = await begin(key, { formValues: { amount: 1, note: 'n' } })
    const t1 = await taskOf(id, 'bob')
    const bad = await act('bob', t1, 'approve', { formValues: { amount: 'x' } }).expect(400)
    expect(bad.body.errors).toEqual([{ path: 'formValues.amount', msg: expect.any(String) }])
    // a read-only field of the wrong type is dropped, not checked
    await act('bob', t1, 'approve', { formValues: { amount: 5, note: 7, other: 1 } }).expect(200)
    expect((await instanceRow(id))!.form_values).toEqual({ amount: 5, note: 'n' })
    // no access on r2: every field is read-only
    await act('carol', await taskOf(id, 'carol'), 'approve', { formValues: { amount: 9 } }).expect(
      200,
    )
    expect((await instanceRow(id))!.form_values).toEqual({ amount: 5, note: 'n' })
  })

  it('resubmit keeps the begin.access edit fields', async () => {
    const key = await model([step('r1', ['bob'])], { fields, access: { amount: 'edit' } })
    const id = await begin(key, { formValues: { amount: 1, note: 'n' } })
    await act('bob', await taskOf(id, 'bob'), 'send-back', { to: 'begin' }).expect(200)
    const b = await taskOf(id, 'alice')
    await act('alice', b, 'resubmit', { formValues: { amount: 'x' } }).expect(400)
    await act('alice', b, 'resubmit', { formValues: { amount: 3, note: 'changed' } }).expect(200)
    expect((await instanceRow(id))!.form_values).toEqual({ amount: 3, note: 'n' })
    expect(await pending(id)).toEqual([['r1', 'bob']])
  })
})

describe('send back and reject', () => {
  const target = (id: string, type = 'review') => ({
    id,
    name: id === 'begin' ? 'Begin' : `${id} step`,
    type,
  })

  it('targets: steps passed, newest first, then begin; others → 422; begin gives the initiator a task', async () => {
    const id = await begin(
      await model([step('r1', ['bob']), step('r2', ['carol']), step('r3', ['erin'])]),
    )
    await act('bob', await taskOf(id, 'bob'), 'approve').expect(200)
    await act('carol', await taskOf(id, 'carol'), 'approve').expect(200)
    const t3 = await taskOf(id, 'erin')
    const { body } = await targetsOf('erin', t3).expect(200)
    expect(body.data).toEqual([target('r2'), target('r1'), target('begin', 'begin')])
    for (const to of ['r3', 'nope']) await act('erin', t3, 'send-back', { to }).expect(422)
    await act('erin', t3, 'send-back', { to: 'r1', comment: 'redo' }).expect(200)
    expect(await taskRow(t3)).toEqual({ state: 'sent_back', comment: 'redo' })
    expect(await pending(id)).toEqual([['r1', 'bob']])
    const t1 = await taskOf(id, 'bob')
    expect((await targetsOf('bob', t1).expect(200)).body.data).toEqual([target('begin', 'begin')])
    await act('bob', t1, 'send-back', { to: 'begin' }).expect(200)
    expect(await pending(id)).toEqual([['begin', 'alice']])
    expect(await instanceRow(id)).toMatchObject({ state: 'running', active_node_ids: ['begin'] })
  })

  it('reject: onReject sendBack returns to the last step passed, finish ends the instance', async () => {
    const id = await begin(
      await model([step('r1', ['bob']), step('r2', ['carol'], { onReject: 'sendBack' })]),
    )
    await act('bob', await taskOf(id, 'bob'), 'approve').expect(200)
    const t2 = await taskOf(id, 'carol')
    await act('carol', t2, 'reject', { comment: 'no' }).expect(200)
    expect(await taskRow(t2)).toEqual({ state: 'rejected', comment: 'no' })
    expect(await pending(id)).toEqual([['r1', 'bob']])
    await act('bob', await taskOf(id, 'bob'), 'reject').expect(200)
    expect(await instanceRow(id)).toMatchObject({ state: 'rejected', active_node_ids: [] })
    expect(await pending(id)).toEqual([])
  })

  it('parallel paths: targets stay on the own path; a send-back resets only its path, one before the fork re-enters it', async () => {
    const id = await begin(
      await model([
        step('r0', ['bob']),
        parallel('f', [chain(step('a1', ['carol']), step('a2', ['erin'])), step('b1', ['frank'])]),
      ]),
    )
    await act('bob', await taskOf(id, 'bob'), 'approve').expect(200)
    await act('carol', await taskOf(id, 'carol'), 'approve').expect(200)
    await act('frank', await taskOf(id, 'frank'), 'approve').expect(200)
    const a2 = await taskOf(id, 'erin')
    // b1 was approved last, on the sibling path
    expect((await targetsOf('erin', a2).expect(200)).body.data).toEqual([
      target('a1'),
      target('r0'),
      target('begin', 'begin'),
    ])
    await act('erin', a2, 'send-back', { to: 'b1' }).expect(422)
    await act('erin', a2, 'send-back', { to: 'a1' }).expect(200)
    // path b stays done, waiting at the join
    expect(await pending(id)).toEqual([['a1', 'carol']])
    await act('carol', await taskOf(id, 'carol'), 'send-back', { to: 'r0' }).expect(200)
    expect(await pending(id)).toEqual([['r0', 'bob']])
    await act('bob', await taskOf(id, 'bob'), 'approve').expect(200)
    expect(await pending(id)).toEqual([
      ['a1', 'carol'],
      ['b1', 'frank'],
    ])
  })
})

describe('resubmit', () => {
  it('restart walks from begin.next; a resubmitTo sender step gets the task back directly', async () => {
    const key = await model([step('r1', ['bob']), step('r2', ['carol'], { resubmitTo: 'sender' })])
    const restart = await begin(key)
    await act('bob', await taskOf(restart, 'bob'), 'send-back', { to: 'begin' }).expect(200)
    await act('alice', await taskOf(restart, 'alice'), 'resubmit', { comment: 'again' }).expect(200)
    expect(await pending(restart)).toEqual([['r1', 'bob']])
    expect(await eventCount(restart, 'resubmit')).toBe(1)

    const sender = await begin(key)
    await act('bob', await taskOf(sender, 'bob'), 'approve').expect(200)
    await act('carol', await taskOf(sender, 'carol'), 'send-back', { to: 'begin' }).expect(200)
    await act('alice', await taskOf(sender, 'alice'), 'resubmit').expect(200)
    expect(await pending(sender)).toEqual([['r2', 'carol']])
  })
})

describe('custom form', () => {
  const leave = (days: number) =>
    insertRow(ds.manager, 'biz_leave_request', {
      user_id: u.alice,
      leave_kind: 'annual',
      start_at: new Date(),
      end_at: new Date(),
      days,
      reason: REASON,
    })
  const leaveState = async (id: number) =>
    (
      await ds.query<{ state: string }[]>(
        'SELECT state FROM biz_leave_request WHERE id = ? AND deleted_at IS NULL',
        [id],
      )
    )[0]!.state

  beforeAll(async () => {
    const edit = { days: 'edit' } as const
    await model(
      [
        step('r1', ['bob'], { access: edit }),
        {
          id: 'f',
          type: 'fork',
          name: 'Fork',
          paths: [
            {
              id: 'p-long',
              name: 'Long',
              when: [[{ field: 'days', op: 'gt', value: 2 }]],
              child: step('long', ['carol']),
            },
            {
              id: 'p-else',
              name: 'Else',
              fallback: true,
              when: [],
              child: step('short', ['erin']),
            },
          ],
        },
      ],
      { custom: true, access: edit },
    )
  })
  afterEach(() => {
    handler.failOn = null
  })

  it("form values are the business row's: approve ignores formValues, resubmit reads the row again", async () => {
    const row = await leave(3)
    const id = await begin(LEAVE, { businessKey: String(row) })
    await act('bob', await taskOf(id, 'bob'), 'approve', { formValues: { days: 1 } }).expect(200)
    expect((await instanceRow(id))!.form_values).toEqual({ days: 3 })
    await act('carol', await taskOf(id, 'carol'), 'send-back', { to: 'begin' }).expect(200)
    // the initiator edits the row on the business page, then resubmits
    await ds.query('UPDATE biz_leave_request SET days = 1 WHERE id = ?', [row])
    await act('alice', await taskOf(id, 'alice'), 'resubmit', { formValues: { days: 5 } }).expect(
      200,
    )
    expect((await instanceRow(id))!.form_values).toEqual({ days: 1 })
    await act('bob', await taskOf(id, 'bob'), 'approve').expect(200)
    expect(await pending(id)).toEqual([['short', 'erin']])
  })

  it('a business handler that throws rolls the whole action back', async () => {
    const row = await leave(1)
    const id = await begin(LEAVE, { businessKey: String(row) })
    await act('bob', await taskOf(id, 'bob'), 'approve').expect(200)
    const t = await taskOf(id, 'erin')
    handler.failOn = 'approved'
    await act('erin', t, 'approve').expect(500)
    expect(await taskRow(t)).toEqual({ state: 'pending', comment: null })
    expect(await instanceRow(id)).toMatchObject({ state: 'running', active_node_ids: ['short'] })
    expect(await eventCount(id, 'approve')).toBe(1)
    expect(await leaveState(row)).toBe('in_review')
    handler.failOn = null
    await act('erin', t, 'approve').expect(200)
    expect(await leaveState(row)).toBe('approved')
  })
})
