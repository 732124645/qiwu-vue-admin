// wf routing and lifecycle actions (转办/委派/加签/减签/抄送/撤回/评论/撤销实例/催办; see docs/design-notes.md#workflow): POST /wf/tasks/:id/{transfer,delegate,add-sign,remove-sign,cc,comment,withdraw} by the task's
// holder (withdraw: who approved it) and POST /wf/instances/:id/{cancel,urge} by the initiator; anybody else,
// a wf.task.manage admin too, gets 404. Withdraw hands the engine every wf_event row of the instance; urge is
// once an hour per instance (`urged_at`, else 429). Instances start through WfStartService.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, type WfStep } from '@qiwu/shared'
import { ClsService } from 'nestjs-cls'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { WfStartService } from '../../src/modules/workflow/center/wf-start.service.js'
import { chain, review } from '../fixtures/wf/flow.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'e2e-wfr-'

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let cls: ClsService
let starts: WfStartService
const tokens: Record<string, string> = {}
const u: Record<string, number> = {}
const made = { iam_user: [] as number[], iam_dept: [] as number[] }
let seq = 0

type Who = 'alice' | 'bob' | 'carol' | 'erin' | 'frank' | 'admin'
const post = (who: Who | null, path: string, body: object = {}) => {
  const req = request(app.getHttpServer()).post(`/api/wf/${path}`)
  return (who ? req.set(bearer(tokens[who]!)) : req).send(body)
}
const act = (who: Who | null, taskId: number, action: string, body: object = {}) =>
  post(who, `tasks/${taskId}/${action}`, body)
const onInstance = (who: Who | null, id: number, action: 'cancel' | 'urge', body: object = {}) =>
  post(who, `instances/${id}/${action}`, body)

/** a review step of `who` (`any`), autoPass, onReject finish */
const step = (id: string, who: Who[], extra: Partial<Extract<WfStep, { type: 'review' }>> = {}) =>
  review(id, {
    name: `${id} step`,
    assignee: { kind: 'users', ids: who.map((w) => u[w]!) },
    ...extra,
  })

/** A dynamic model with one published version of begin → `steps`; its key. */
async function model(
  steps: WfStep[],
  opts: { allowCancel?: boolean; allowWithdraw?: boolean } = {},
): Promise<string> {
  const key = `${PREFIX}m${++seq}`
  const root = { id: 'begin', type: 'begin', name: 'Begin', next: chain(...steps) }
  const m = await ds.query(
    `INSERT INTO wf_model (model_key, name, form_kind, allow_cancel, allow_withdraw)
     VALUES (?, ?, 'dynamic', ?, ?)`,
    [key, key, opts.allowCancel ?? true, opts.allowWithdraw ?? true],
  )
  const v = await ds.query(
    `INSERT INTO wf_version (model_id, model_key, version, tree_json, form_snapshot)
     VALUES (?, ?, 1, ?, ?)`,
    [m.insertId, key, JSON.stringify(root), JSON.stringify({ fields: {} })],
  )
  await ds.query('UPDATE wf_model SET current_version_id = ? WHERE id = ?', [
    v.insertId,
    m.insertId,
  ])
  return key
}

/** alice starts `modelKey` through the start service; the instance id */
async function begin(modelKey: string) {
  const { inst } = await cls.run(() =>
    starts.start(u.alice!, { formValues: {}, initiatorPicks: {}, modelKey }),
  )
  return inst.id
}

/** the tasks of instance `id` as [node, assignee name, state], in creation order */
async function tasks(id: number) {
  const rows = await ds.query<{ node_id: string; assignee_id: number; state: string }[]>(
    `SELECT node_id, assignee_id, state FROM wf_task WHERE instance_id = ? AND deleted_at IS NULL
      ORDER BY id`,
    [id],
  )
  return rows.map((r) => [r.node_id, nameOf(r.assignee_id), r.state])
}
const nameOf = (userId: number) => Object.keys(u).find((k) => u[k] === Number(userId))

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

const instanceRow = async (id: number) =>
  (
    await ds.query<{ state: string; urged_at: Date | null }[]>(
      'SELECT state, urged_at FROM wf_instance WHERE id = ? AND deleted_at IS NULL',
      [id],
    )
  )[0]!
/** [actor name, target names or ids, comment] of the instance's `action` events */
const events = async (id: number, action: string) =>
  (
    await ds.query<{ actor_id: number; target_ids: number[] | null; comment: string | null }[]>(
      'SELECT actor_id, target_ids, comment FROM wf_event WHERE instance_id = ? AND action = ? ORDER BY id',
      [id, action],
    )
  ).map((e) => [nameOf(e.actor_id), e.target_ids?.map(nameOf) ?? null, e.comment])

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
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  cls = app.get(ClsService)
  starts = app.get(WfStartService)
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

describe('task actions: holder only', () => {
  it("another user's task id → 404 for every action (a wf.task.manage admin too); unknown → 404", async () => {
    const id = await begin(await model([step('r1', ['bob'])]))
    const t1 = await taskOf(id, 'bob')
    const calls: [string, object][] = [
      ['transfer', { userId: u.erin }],
      ['delegate', { userId: u.erin }],
      ['add-sign', { kind: 'before', userIds: [u.erin] }],
      ['remove-sign', { taskIds: [t1] }],
      ['cc', { userIds: [u.erin] }],
      ['comment', { comment: 'hi' }],
      ['withdraw', {}],
    ]
    for (const [action, body] of calls) {
      await act(null, t1, action, body).expect(401)
      for (const who of ['carol', 'alice', 'admin'] as const)
        await act(who, t1, action, body).expect(404)
      await act('bob', 999_999_999, action, body).expect(404)
    }
    expect(await tasks(id)).toEqual([['r1', 'bob', 'pending']])
    const other = 'SELECT id FROM wf_event WHERE instance_id = ? AND action <> ?'
    expect(await ds.query(other, [id, 'begin'])).toEqual([])
    expect(await ds.query('SELECT id FROM wf_cc WHERE instance_id = ?', [id])).toEqual([])
  })

  it('transfer: the task closes as transferred, the user gets it; a bad target 422; again 409', async () => {
    const id = await begin(await model([step('r1', ['bob']), step('r2', ['erin'])]))
    const t1 = await taskOf(id, 'bob')
    for (const userId of [u.bob, 999_999_999]) {
      const res = await act('bob', t1, 'transfer', { userId }).expect(422)
      expect(res.body.code).toBe(Err.WF_BAD_TARGET.code)
    }
    await act('bob', t1, 'transfer', { userId: u.carol, comment: ' away ' }).expect(200)
    expect(await tasks(id)).toEqual([
      ['r1', 'bob', 'transferred'],
      ['r1', 'carol', 'pending'],
    ])
    expect(await events(id, 'transfer')).toEqual([['bob', ['carol'], 'away']])
    await act('bob', t1, 'transfer', { userId: u.frank }).expect(409)
    await act('carol', await taskOf(id, 'carol'), 'approve').expect(200)
    expect(await tasks(id)).toContainEqual(['r2', 'erin', 'pending'])
  })

  it('delegate: the delegate handles it first, then it is back with the owner to decide', async () => {
    const id = await begin(await model([step('r1', ['bob'])]))
    const t1 = await taskOf(id, 'bob')
    await act('bob', t1, 'delegate', { userId: u.carol }).expect(200)
    expect(await tasks(id)).toEqual([
      ['r1', 'bob', 'delegated'],
      ['r1', 'carol', 'pending'],
    ])
    expect(await events(id, 'delegate')).toEqual([['bob', ['carol'], null]])
    await act('carol', await taskOf(id, 'carol'), 'approve').expect(200)
    expect(await tasks(id)).toEqual([
      ['r1', 'bob', 'pending'],
      ['r1', 'carol', 'approved'],
    ])
    await act('bob', t1, 'approve').expect(200)
    expect((await instanceRow(id)).state).toBe('approved')
  })

  it('add-sign before holds the task until the signers approved; remove-sign cancels pending ones', async () => {
    const id = await begin(await model([step('r1', ['bob'])]))
    const t1 = await taskOf(id, 'bob')
    await act('bob', t1, 'add-sign', { kind: 'middle', userIds: [u.erin] }).expect(400)
    await act('bob', t1, 'add-sign', { kind: 'before', userIds: [u.erin, u.frank] }).expect(200)
    expect(await tasks(id)).toEqual([
      ['r1', 'bob', 'waiting'],
      ['r1', 'erin', 'pending'],
      ['r1', 'frank', 'pending'],
    ])
    // not an add-sign task of t1 → 404
    await act('bob', t1, 'remove-sign', { taskIds: [t1] }).expect(404)
    await act('bob', t1, 'remove-sign', { taskIds: [await taskOf(id, 'frank')] }).expect(200)
    expect(await events(id, 'remove_sign')).toEqual([['bob', ['frank'], null]])
    await act('erin', await taskOf(id, 'erin'), 'approve').expect(200)
    expect(await tasks(id)).toEqual([
      ['r1', 'bob', 'pending'],
      ['r1', 'erin', 'approved'],
      ['r1', 'frank', 'canceled'],
    ])
    await act('bob', t1, 'approve').expect(200)
    expect((await instanceRow(id)).state).toBe('approved')
  })

  it('add-sign after approves the task now, in effect once the signers approved', async () => {
    const id = await begin(await model([step('r1', ['bob']), step('r2', ['carol'])]))
    const t1 = await taskOf(id, 'bob')
    await act('bob', t1, 'add-sign', { kind: 'after', userIds: [u.erin] }).expect(200)
    expect(await tasks(id)).toEqual([
      ['r1', 'bob', 'approved'],
      ['r1', 'erin', 'pending'],
    ])
    await act('erin', await taskOf(id, 'erin'), 'approve').expect(200)
    expect(await tasks(id)).toContainEqual(['r2', 'carol', 'pending'])
  })

  it('add-sign after is an approval: a commentRequired step wants its comment (422); before does not', async () => {
    const id = await begin(await model([step('r1', ['bob'], { commentRequired: true })]))
    const t1 = await taskOf(id, 'bob')
    for (const comment of [undefined, '  ']) {
      const res = await act('bob', t1, 'add-sign', {
        kind: 'after',
        userIds: [u.erin],
        comment,
      }).expect(422)
      expect(res.body.code).toBe(Err.WF_COMMENT_REQUIRED.code)
    }
    expect(await tasks(id)).toEqual([['r1', 'bob', 'pending']])
    expect(await events(id, 'approve')).toEqual([])
    await act('bob', t1, 'add-sign', { kind: 'after', userIds: [u.erin], comment: 'ok' }).expect(
      200,
    )
    expect(await events(id, 'approve')).toEqual([['bob', null, 'ok']])

    const other = await begin(await model([step('r1', ['bob'], { commentRequired: true })]))
    await act('bob', await taskOf(other, 'bob'), 'add-sign', {
      kind: 'before',
      userIds: [u.erin],
    }).expect(200)
  })

  it('cc: a wf_cc row per user from the task; none → 400, a user not enabled → 422', async () => {
    const id = await begin(await model([step('r1', ['bob'])]))
    const t1 = await taskOf(id, 'bob')
    await act('bob', t1, 'cc', { userIds: [] }).expect(400)
    await act('bob', t1, 'cc', { userIds: [u.erin, 999_999_999] }).expect(422)
    const body = { userIds: [u.erin, u.frank, u.erin], reason: 'fyi' }
    await act('bob', t1, 'cc', body).expect(200)
    // a double submit (@Idempotent)
    await act('bob', t1, 'cc', body).expect(429)
    const rows = await ds.query<
      { user_id: number; from_task_id: number; from_user_id: number; reason: string }[]
    >(
      'SELECT user_id, from_task_id, from_user_id, reason FROM wf_cc WHERE instance_id = ? ORDER BY id',
      [id],
    )
    expect(
      rows.map((r) => [
        nameOf(r.user_id),
        Number(r.from_task_id),
        nameOf(r.from_user_id),
        r.reason,
      ]),
    ).toEqual([
      ['erin', t1, 'bob', 'fyi'],
      ['frank', t1, 'bob', 'fyi'],
    ])
    expect(await tasks(id)).toEqual([['r1', 'bob', 'pending']])
  })

  it('comment: an event on the pending task, nothing else; a blank one → 400; a handled task → 409', async () => {
    const id = await begin(await model([step('r1', ['bob']), step('r2', ['carol'])]))
    const t1 = await taskOf(id, 'bob')
    await act('bob', t1, 'comment', { comment: '  ' }).expect(400)
    await act('bob', t1, 'comment', { comment: ' a question ' }).expect(200)
    await act('bob', t1, 'comment', { comment: ' a question ' }).expect(429)
    expect(await events(id, 'comment')).toEqual([['bob', null, 'a question']])
    expect(await tasks(id)).toEqual([['r1', 'bob', 'pending']])
    await act('bob', t1, 'approve').expect(200)
    await act('bob', t1, 'comment', { comment: 'late' }).expect(409)
  })
})

describe('withdraw (撤回)', () => {
  it('the approver takes the approval back while the next task is untouched', async () => {
    const id = await begin(await model([step('r1', ['bob']), step('r2', ['carol'])]))
    const t1 = await taskOf(id, 'bob')
    await act('bob', t1, 'withdraw').expect(409)
    await act('bob', t1, 'approve').expect(200)
    await act('carol', t1, 'withdraw').expect(404)
    await act('bob', t1, 'withdraw', { comment: 'oops' }).expect(200)
    expect(await tasks(id)).toEqual([
      ['r1', 'bob', 'pending'],
      ['r2', 'carol', 'withdrawn'],
    ])
    expect(await events(id, 'withdraw')).toEqual([['bob', null, 'oops']])
    await act('bob', t1, 'approve').expect(200)
    expect(await tasks(id)).toContainEqual(['r2', 'carol', 'pending'])
  })

  it("gets the instance's wf_event rows: a comment on the next task blocks it (409)", async () => {
    const id = await begin(await model([step('r1', ['bob']), step('r2', ['carol'])]))
    const t1 = await taskOf(id, 'bob')
    await act('bob', t1, 'approve').expect(200)
    await act('carol', await taskOf(id, 'carol'), 'comment', { comment: 'looking' }).expect(200)
    await act('bob', t1, 'withdraw').expect(409)
    expect(await tasks(id)).toEqual([
      ['r1', 'bob', 'approved'],
      ['r2', 'carol', 'pending'],
    ])
  })

  it('an after-signer taken off by remove-sign counts as untouched', async () => {
    const id = await begin(await model([step('r1', ['bob'])]))
    const t1 = await taskOf(id, 'bob')
    await act('bob', t1, 'add-sign', { kind: 'after', userIds: [u.erin, u.frank] }).expect(200)
    await act('bob', t1, 'remove-sign', { taskIds: [await taskOf(id, 'frank')] }).expect(200)
    await act('bob', t1, 'withdraw').expect(200)
    expect(await tasks(id)).toEqual([
      ['r1', 'bob', 'pending'],
      ['r1', 'erin', 'withdrawn'],
      ['r1', 'frank', 'canceled'],
    ])
  })

  it('a model without allow_withdraw → 403, nothing changes', async () => {
    const key = await model([step('r1', ['bob']), step('r2', ['carol'])], { allowWithdraw: false })
    const id = await begin(key)
    const t1 = await taskOf(id, 'bob')
    await act('bob', t1, 'approve').expect(200)
    await act('bob', t1, 'withdraw').expect(403)
    expect(await tasks(id)).toEqual([
      ['r1', 'bob', 'approved'],
      ['r2', 'carol', 'pending'],
    ])
  })
})

describe('cancel (撤销实例)', () => {
  it('the initiator cancels: every open task canceled; anybody else → 404; an ended one → 409', async () => {
    const id = await begin(await model([step('r1', ['bob', 'carol'])]))
    await onInstance(null, id, 'cancel').expect(401)
    for (const who of ['bob', 'admin'] as const) await onInstance(who, id, 'cancel').expect(404)
    await onInstance('alice', 999_999_999, 'cancel').expect(404)
    await onInstance('alice', id, 'cancel', { comment: 'not needed' }).expect(200)
    expect((await instanceRow(id)).state).toBe('canceled')
    expect(await tasks(id)).toEqual([
      ['r1', 'bob', 'canceled'],
      ['r1', 'carol', 'canceled'],
    ])
    expect(await events(id, 'cancel')).toEqual([['alice', null, 'not needed']])
    await onInstance('alice', id, 'cancel').expect(409)
  })

  it('a model without allow_cancel → 403, unless it was sent back to the initiator', async () => {
    const id = await begin(await model([step('r1', ['bob'])], { allowCancel: false }))
    await onInstance('alice', id, 'cancel').expect(403)
    expect((await instanceRow(id)).state).toBe('running')
    await act('bob', await taskOf(id, 'bob'), 'send-back', { to: 'begin' }).expect(200)
    await onInstance('alice', id, 'cancel').expect(200)
    expect((await instanceRow(id)).state).toBe('canceled')
  })
})

describe('urge (催办)', () => {
  it('the initiator urges the pending reviewers once an hour (again → 429); anybody else → 404', async () => {
    const id = await begin(await model([step('r1', ['bob', 'carol'])]))
    await onInstance(null, id, 'urge').expect(401)
    for (const who of ['bob', 'admin'] as const) await onInstance(who, id, 'urge').expect(404)
    await onInstance('alice', 999_999_999, 'urge').expect(404)
    expect((await instanceRow(id)).urged_at).toBeNull()
    await onInstance('alice', id, 'urge').expect(200)
    expect(await events(id, 'urge')).toEqual([['alice', ['bob', 'carol'], null]])
    expect((await instanceRow(id)).urged_at).toBeInstanceOf(Date)
    const res = await onInstance('alice', id, 'urge').expect(429)
    expect(res.body.code).toBe(Err.TOO_MANY_REQUESTS.code)
    const urgedAgo = (min: number) =>
      ds.query('UPDATE wf_instance SET urged_at = ? WHERE id = ?', [
        new Date(Date.now() - min * 60_000),
        id,
      ])
    await urgedAgo(59)
    await onInstance('alice', id, 'urge').expect(429)
    await urgedAgo(61)
    await onInstance('alice', id, 'urge').expect(200)
    expect(await events(id, 'urge')).toHaveLength(2)
  })

  it('nothing to urge (409) while it waits for the initiator or once it ended', async () => {
    const id = await begin(await model([step('r1', ['bob'])]))
    await act('bob', await taskOf(id, 'bob'), 'send-back', { to: 'begin' }).expect(200)
    await onInstance('alice', id, 'urge').expect(409)
    await act('alice', await taskOf(id, 'alice'), 'resubmit').expect(200)
    await act('bob', await taskOf(id, 'bob'), 'approve').expect(200)
    expect((await instanceRow(id)).state).toBe('approved')
    await onInstance('alice', id, 'urge').expect(409)
    expect((await instanceRow(id)).urged_at).toBeNull()
    expect(await events(id, 'urge')).toEqual([])
  })
})
