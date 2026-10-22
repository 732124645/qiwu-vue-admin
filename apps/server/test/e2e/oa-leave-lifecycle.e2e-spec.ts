import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import { compile, type WfBeginNode, type WfReviewNode } from '@qiwu/shared'
import request from 'supertest'
import { Repository, type DataSource, type ObjectLiteral } from 'typeorm'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { LeaveWfHandler, LEAVE_FIELDS } from '../../src/modules/biz/leave/leave-wf.handler.js'
import { bearer } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import {
  addRow,
  addUser,
  bootApp,
  createTenant,
  signInDirect,
  type TestTenant,
} from '../setup/tenants.js'

interface Side {
  tenant: TestTenant
  applicant: string
  reviewer: number
  reviewerToken: string
  outsider: string
  manager: string
}
let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let a: Side
let b: Side
const tenants: TestTenant[] = []
let serial = 0
let version = 1

const api = (token: string, method: 'get' | 'post' | 'put', path: string, body?: object) => {
  const call = request(app.getHttpServer())[method](`/api${path}`).set(bearer(token))
  return body ? call.send(body) : call
}
const body = (over: object = {}) => ({
  leaveKind: 'annual',
  startAt: '2026-10-22T01:00:00Z',
  endAt: '2026-10-24T10:00:00Z',
  days: 3,
  reason: `Leave request ${++serial}`,
  ...over,
})
const reviewNode = (side: Side, pick = false): WfReviewNode => ({
  id: 'review',
  type: 'review',
  name: 'Review',
  assignee: pick ? { kind: 'initiatorPicks' } : { kind: 'users', ids: [side.reviewer] },
  sign: 'any',
  whenNobody: 'autoPass',
  whenInitiatorIsReviewer: 'self',
  onReject: 'finish',
})

/** 每个租户只改自己的测试模型，新版本不改动已发起实例的快照。 */
async function publish(side: Side, pick = false) {
  const tree: WfBeginNode = {
    id: 'begin',
    type: 'begin',
    name: 'Start',
    next: reviewNode(side, pick),
  }
  const compiled = compile(tree, LEAVE_FIELDS)
  if (!compiled.ok) throw new Error('Invalid test flow')
  const [model] = await ds.query<{ id: number }[]>(
    'SELECT id FROM wf_model WHERE model_key = ? AND tenant_id = ? AND deleted_at IS NULL',
    ['leave', side.tenant.id],
  )
  const id = await addRow(app, side.tenant.id, 'wf_version', {
    model_id: model.id,
    model_key: 'leave',
    version: ++version,
    tree_json: compiled.flow.root,
    form_snapshot: { fields: LEAVE_FIELDS },
  })
  await ds.query(
    'UPDATE wf_model SET current_version_id = ?, draft_json = ?, allow_cancel = 1 WHERE id = ? AND tenant_id = ?',
    [id, JSON.stringify(compiled.flow.root), model.id, side.tenant.id],
  )
}

async function side(): Promise<Side> {
  const tenant = await createTenant(app)
  tenants.push(tenant)
  await ds.query(
    'UPDATE iam_user SET password_changed_at = NOW(3) WHERE id = ? AND tenant_id = ?',
    [tenant.ownerId, tenant.id],
  )
  const reviewer = await addUser(app, tenant.id, 'reviewer')
  const outsider = await addUser(app, tenant.id, 'outsider')
  const [role] = await ds.query<{ role_id: number }[]>(
    'SELECT role_id FROM iam_user_roles WHERE user_id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [tenant.ownerId, tenant.id],
  )
  const manager = await addUser(app, tenant.id, 'manager', { roleId: role.role_id })
  const token = async (id: number) => (await signInDirect(app, id))!.accessToken
  return {
    tenant,
    applicant: await token(tenant.ownerId),
    reviewer,
    reviewerToken: await token(reviewer),
    outsider: await token(outsider),
    manager: await token(manager),
  }
}
const submit = async (side: Side, over: object = {}) =>
  (await api(side.applicant, 'post', '/biz/leaves', body(over)).expect(201)).body.data as {
    id: number
    instanceId: number
  }
const row = async (side: Side, id: number) =>
  (
    await ds.query<
      {
        id: number
        user_id: number
        dept_id: number | null
        state: string
        days: string
        instance_id: number | null
        start_at: Date
        end_at: Date
        reason: string
      }[]
    >('SELECT * FROM biz_leave_request WHERE id = ? AND tenant_id = ?', [id, side.tenant.id])
  )[0]!
const pending = async (side: Side, id: number, node = 'review') =>
  (
    await ds.query<{ id: number; assignee_id: number }[]>(
      'SELECT id, assignee_id FROM wf_task WHERE instance_id = ? AND tenant_id = ? AND node_id = ? AND state = ? AND deleted_at IS NULL',
      [id, side.tenant.id, node, 'pending'],
    )
  )[0]!
const state = async (side: Side, id: number) =>
  (
    await ds.query<
      { state: string; form_values: { days: number }; initiator_picks: Record<string, number[]> }[]
    >(
      'SELECT state, form_values, initiator_picks FROM wf_instance WHERE id = ? AND tenant_id = ?',
      [id, side.tenant.id],
    )
  )[0]!
const count = async (side: Side) =>
  Number(
    (
      await ds.query<{ n: number }[]>(
        'SELECT COUNT(*) AS n FROM biz_leave_request WHERE tenant_id = ?',
        [side.tenant.id],
      )
    )[0].n,
  )
const draft = (side: Side, over: object = {}) =>
  addRow(app, side.tenant.id, 'biz_leave_request', {
    user_id: side.tenant.ownerId,
    leave_kind: 'annual',
    start_at: new Date('2026-10-22T01:00:00Z'),
    end_at: new Date('2026-10-24T10:00:00Z'),
    days: 3,
    reason: `Draft ${++serial}`,
    ...over,
  })
async function sendBack(side: Side, instanceId: number) {
  const task = await pending(side, instanceId)
  await api(side.reviewerToken, 'post', `/wf/tasks/${task.id}/send-back`, { to: 'begin' }).expect(
    200,
  )
  return pending(side, instanceId, 'begin')
}

beforeAll(async () => {
  app = await bootApp({ multiTenant: true })
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  await cleanRedis(redis)
  a = await side()
  b = await side()
  await publish(a)
  await publish(b)
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  vi.restoreAllMocks()
  for (const tenant of tenants.reverse()) await tenant.dispose()
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('leave request lifecycle', () => {
  it('rejects invalid intervals and declared durations before creating a business row', async () => {
    const before = await count(a)
    for (const over of [
      { endAt: '2026-10-22T01:00:00Z' },
      { endAt: '2026-10-21T01:00:00Z' },
      { endAt: '2026-10-22T09:00:00+08:00' },
      { days: 0 },
      { days: -1 },
      { days: 10000 },
    ])
      await api(a.applicant, 'post', '/biz/leaves', body(over)).expect(400)
    expect(await count(a)).toBe(before)
    const saved = await submit(a, { days: 0.1, endAt: '2026-10-22T09:01:00+08:00' })
    expect(Number((await row(a, saved.id)).days)).toBe(0.1)
  })

  it('keeps old callers compatible and ignores submitted identity, state and instance fields', async () => {
    await publish(a)
    const saved = await submit(a, {
      userId: b.tenant.ownerId,
      tenantId: b.tenant.id,
      deptId: 123456,
      state: 'approved',
      instanceId: 123456,
    })
    expect(await row(a, saved.id)).toMatchObject({ user_id: a.tenant.ownerId, state: 'in_review' })
    expect((await state(a, saved.instanceId)).initiator_picks).toEqual({})
    expect((await pending(a, saved.instanceId)).assignee_id).toBe(a.reviewer)
  })

  it('uses the existing initiator picks and rejects missing or cross-tenant selected reviewers atomically', async () => {
    await publish(a, true)
    const info = await api(a.applicant, 'get', '/wf/models/leave/start-info').expect(200)
    expect(info.body.data.picks).toMatchObject([{ id: 'review' }])
    const before = await count(a)
    await api(a.applicant, 'post', '/biz/leaves', body()).expect(400)
    await api(
      a.applicant,
      'post',
      '/biz/leaves',
      body({ initiatorPicks: { review: [b.reviewer] } }),
    ).expect(400)
    expect(await count(a)).toBe(before)
    const saved = await submit(a, { initiatorPicks: { review: [a.reviewer] } })
    expect((await pending(a, saved.instanceId)).assignee_id).toBe(a.reviewer)
    expect((await state(a, saved.instanceId)).initiator_picks).toEqual({ review: [a.reviewer] })
    await publish(a)
  })

  it('keeps permission, participant and cross-tenant boundaries on existing endpoints', async () => {
    const saved = await submit(a)
    await api(a.outsider, 'post', '/biz/leaves', body()).expect(403)
    await api(a.applicant, 'get', `/biz/leaves/${saved.id}`).expect(200)
    await api(a.reviewerToken, 'get', `/biz/leaves/${saved.id}`).expect(200)
    await api(a.outsider, 'get', `/biz/leaves/${saved.id}`).expect(404)
    await api(b.applicant, 'get', `/biz/leaves/${saved.id}`).expect(404)
    await api(b.applicant, 'put', `/biz/leaves/${saved.id}`, { reason: 'Wrong tenant' }).expect(404)
    await api(a.manager, 'put', `/biz/leaves/${saved.id}`, { reason: 'Another owner' }).expect(404)
    await api(a.reviewerToken, 'put', `/biz/leaves/${saved.id}`, { reason: 'Wrong owner' }).expect(
      403,
    )
  })

  it('validates a partial time edit against the locked current row and preserves historical reads', async () => {
    const id = await draft(a)
    await api(a.applicant, 'put', `/biz/leaves/${id}`, { startAt: '2026-10-25T01:00:00Z' }).expect(
      400,
    )
    await api(a.applicant, 'put', `/biz/leaves/${id}`, { endAt: '2026-10-21T01:00:00Z' }).expect(
      400,
    )
    await api(a.applicant, 'put', `/biz/leaves/${id}`, { endAt: '2026-10-25T01:00:00Z' }).expect(
      200,
    )
    const historical = await draft(a, { end_at: new Date('2026-10-21T01:00:00Z') })
    await api(a.applicant, 'get', `/biz/leaves/${historical}`).expect(200)
    await api(a.applicant, 'put', `/biz/leaves/${historical}`, {
      reason: 'Historical note',
    }).expect(200)
    expect((await row(a, historical)).reason).toBe('Historical note')
    await api(a.applicant, 'post', '/wf/instances', {
      modelKey: 'leave',
      businessKey: String(historical),
      formValues: { days: 0.1 },
    }).expect(400)
    expect((await row(a, historical)).instance_id).toBeNull()
  })

  it('edits only an owner begin task and resubmits stored values before the final approval writeback', async () => {
    const saved = await submit(a)
    await api(a.applicant, 'put', `/biz/leaves/${saved.id}`, { days: 1 }).expect(409)
    const begin = await sendBack(a, saved.instanceId)
    await api(b.applicant, 'put', `/biz/leaves/${saved.id}`, { days: 1 }).expect(404)
    await api(a.applicant, 'put', `/biz/leaves/${saved.id}`, {
      days: 1,
      reason: 'Updated by applicant',
    }).expect(200)
    await api(a.applicant, 'post', `/wf/tasks/${begin.id}/resubmit`, {
      formValues: { days: 999 },
    }).expect(200)
    expect((await state(a, saved.instanceId)).form_values.days).toBe(1)
    const task = await pending(a, saved.instanceId)
    await api(a.reviewerToken, 'post', `/wf/tasks/${task.id}/approve`, {}).expect(200)
    expect((await row(a, saved.id)).state).toBe('approved')
    await api(a.applicant, 'put', `/biz/leaves/${saved.id}`, { reason: 'Too late' }).expect(409)
  })

  it('rolls back both the request and the workflow if its start writeback fails', async () => {
    const before = await count(a)
    const countInstances = async () =>
      Number(
        (
          await ds.query<{ n: number }[]>(
            'SELECT COUNT(*) AS n FROM wf_instance WHERE tenant_id = ?',
            [a.tenant.id],
          )
        )[0].n,
      )
    const instancesBefore = await countInstances()
    vi.spyOn(app.get(LeaveWfHandler), 'onStateChange').mockRejectedValueOnce(
      new Error('Writeback unavailable'),
    )
    await api(a.applicant, 'post', '/biz/leaves', body()).expect(500)
    expect(await count(a)).toBe(before)
    expect(await countInstances()).toBe(instancesBefore)
  })

  it('rolls back a final decision if business writeback fails, then permits a clean retry', async () => {
    const saved = await submit(a)
    const task = await pending(a, saved.instanceId)
    vi.spyOn(app.get(LeaveWfHandler), 'onStateChange').mockRejectedValueOnce(
      new Error('Writeback unavailable'),
    )
    await api(a.reviewerToken, 'post', `/wf/tasks/${task.id}/approve`, {}).expect(500)
    expect((await state(a, saved.instanceId)).state).toBe('running')
    expect((await row(a, saved.id)).state).toBe('in_review')
    expect((await pending(a, saved.instanceId)).id).toBe(task.id)
    await api(a.reviewerToken, 'post', `/wf/tasks/${task.id}/approve`, {}).expect(200)
  })

  it('rechecks a begin task after waiting for resubmit instead of editing a stale transaction snapshot', async () => {
    const saved = await submit(a)
    const begin = await sendBack(a, saved.instanceId)
    let release!: () => void
    let captured!: () => void
    const pause = new Promise<void>((resolve) => (release = resolve))
    const read = new Promise<void>((resolve) => (captured = resolve))
    const findOneBy = Repository.prototype.findOneBy
    let intercepted = false
    vi.spyOn(Repository.prototype, 'findOneBy').mockImplementation(async function (
      this: Repository<ObjectLiteral>,
      where,
    ) {
      const found = await findOneBy.call(this, where)
      if (
        !intercepted &&
        this.metadata.tableName === 'biz_leave_request' &&
        found?.id === saved.id &&
        this.manager.queryRunner?.isTransactionActive
      ) {
        intercepted = true
        captured()
        await pause
      }
      return found
    })
    const editing = api(a.applicant, 'put', `/biz/leaves/${saved.id}`, { days: 7 }).then(
      (answer) => answer,
    )
    try {
      await read
      await api(a.applicant, 'post', `/wf/tasks/${begin.id}/resubmit`, {}).expect(200)
    } finally {
      release()
    }
    expect((await editing).status).toBe(409)
    expect((await state(a, saved.instanceId)).form_values.days).toBe(3)
    expect(Number((await row(a, saved.id)).days)).toBe(3)
  })

  it('rejects a draft that was bound and sent back after the editing snapshot was read', async () => {
    const id = await draft(a)
    let release!: () => void
    let captured!: () => void
    const pause = new Promise<void>((resolve) => (release = resolve))
    const read = new Promise<void>((resolve) => (captured = resolve))
    const findOneBy = Repository.prototype.findOneBy
    let intercepted = false
    vi.spyOn(Repository.prototype, 'findOneBy').mockImplementation(async function (
      this: Repository<ObjectLiteral>,
      where,
    ) {
      const found = await findOneBy.call(this, where)
      if (
        !intercepted &&
        this.metadata.tableName === 'biz_leave_request' &&
        found?.id === id &&
        this.manager.queryRunner?.isTransactionActive
      ) {
        intercepted = true
        captured()
        await pause
      }
      return found
    })
    const editing = api(a.applicant, 'put', `/biz/leaves/${id}`, { days: 7 }).then(
      (answer) => answer,
    )
    try {
      await read
      const started = await api(a.applicant, 'post', '/wf/instances', {
        modelKey: 'leave',
        businessKey: String(id),
      }).expect(201)
      await sendBack(a, started.body.data.id)
    } finally {
      release()
    }
    expect((await editing).status).toBe(409)
    expect(Number((await row(a, id)).days)).toBe(3)
  })

  it('waits for the instance before taking the business lock while a resubmit reads its form', async () => {
    const saved = await submit(a)
    const begin = await sendBack(a, saved.instanceId)
    const handler = app.get(LeaveWfHandler)
    const loadValues = handler.loadFormValues.bind(handler)
    let readForm!: () => void
    let releaseForm!: () => void
    let attemptingLock!: () => void
    const atForm = new Promise<void>((resolve) => (readForm = resolve))
    const resumeForm = new Promise<void>((resolve) => (releaseForm = resolve))
    const atEditLock = new Promise<void>((resolve) => (attemptingLock = resolve))
    vi.spyOn(handler, 'loadFormValues').mockImplementation(async (key, tx) => {
      if (key === String(saved.id)) {
        readForm()
        await resumeForm
      }
      return loadValues(key, tx)
    })
    const resubmitting = api(a.applicant, 'post', `/wf/tasks/${begin.id}/resubmit`, {}).then(
      (answer) => answer,
    )
    await atForm
    const findOne = Repository.prototype.findOne
    vi.spyOn(Repository.prototype, 'findOne').mockImplementation(async function (
      this: Repository<ObjectLiteral>,
      options,
    ) {
      if (options.lock?.mode === 'pessimistic_write') {
        if (this.metadata.tableName === 'wf_instance') attemptingLock()
        if (this.metadata.tableName === 'biz_leave_request') {
          const locked = await findOne.call(this, options)
          attemptingLock()
          return locked
        }
      }
      return findOne.call(this, options)
    })
    const editing = api(a.applicant, 'put', `/biz/leaves/${saved.id}`, { days: 8 }).then(
      (answer) => answer,
    )
    try {
      await atEditLock
    } finally {
      releaseForm()
    }
    expect((await resubmitting).status).toBe(200)
    expect((await editing).status).toBe(409)
    expect((await state(a, saved.instanceId)).form_values.days).toBe(3)
    expect(Number((await row(a, saved.id)).days)).toBe(3)
  })

  it('serializes a simultaneous edit and cancel without reopening a canceled request', async () => {
    const saved = await submit(a)
    await sendBack(a, saved.instanceId)
    const [edited, canceled] = await Promise.all([
      api(a.applicant, 'put', `/biz/leaves/${saved.id}`, { reason: 'Concurrent edit' }),
      api(a.applicant, 'post', `/wf/instances/${saved.instanceId}/cancel`, {}),
    ])
    expect([200, 409]).toContain(edited.status)
    expect(canceled.status).toBe(200)
    expect((await state(a, saved.instanceId)).state).toBe('canceled')
    expect((await row(a, saved.id)).state).toBe('canceled')
    await api(a.applicant, 'put', `/biz/leaves/${saved.id}`, { reason: 'Cannot reopen' }).expect(
      409,
    )
  })

  it('serializes a simultaneous edit and resubmit without deadlock or inconsistent business values', async () => {
    const saved = await submit(a)
    const begin = await sendBack(a, saved.instanceId)
    const [edited, resubmitted] = await Promise.all([
      api(a.applicant, 'put', `/biz/leaves/${saved.id}`, { days: 4 }),
      api(a.applicant, 'post', `/wf/tasks/${begin.id}/resubmit`, {}),
    ])
    expect([200, 409]).toContain(edited.status)
    expect(resubmitted.status).toBe(200)
    expect((await state(a, saved.instanceId)).form_values.days).toBe(
      Number((await row(a, saved.id)).days),
    )
  })
})
