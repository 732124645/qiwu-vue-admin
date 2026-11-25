import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import {
  compile,
  Err,
  oaExpensePerms,
  wfPerms,
  type WfBeginNode,
  type WfReviewNode,
} from '@qiwu/shared'
import request from 'supertest'
import { type DataSource, type ObjectLiteral, Repository } from 'typeorm'
import { PermVersion } from '../../src/core/auth/perm-version.js'
import { withTenant } from '../../src/core/context/tenant.js'
import { findRow, insertRow } from '../../src/db/seeds/upsert.js'
import { expenseTree, seedOaExpense } from '../../src/db/seeds/project/oa-expense.seed.js'
import { OaExpenseItem } from '../../src/modules/oa/expense/expense-item.entity.js'
import { OaExpenseClaim } from '../../src/modules/oa/expense/expense.entity.js'
import {
  ExpenseWfHandler,
  EXPENSE_FIELDS,
  EXPENSE_MODEL,
} from '../../src/modules/oa/expense/expense-wf.handler.js'
import { OaTripRequest } from '../../src/modules/oa/trip/trip.entity.js'
import { WfVersion } from '../../src/modules/workflow/model/wf-model.entity.js'
import { WfInstanceRow, WfTaskRow } from '../../src/modules/workflow/runtime/wf-runtime.entity.js'
import { bearer } from '../setup/auth.js'
import {
  bootApp,
  createPackage,
  createTenant,
  signInDirect,
  type PeopledTenant,
} from '../setup/tenants.js'

let app: NestExpressApplication
let ds: DataSource
let first: PeopledTenant
let second: PeopledTenant
const tokens: Record<string, string> = {}
let seq = 0
const URL = '/api/oa/expense-claims'
const call = (who: string, method: 'get' | 'post' | 'put', path = '', body?: object) => {
  const req = request(app.getHttpServer())
    [method](URL + path)
    .set(bearer(tokens[who]!))
  return body === undefined ? req : req.send(body)
}
const wf = (who: string, path: string, body: object = {}) =>
  request(app.getHttpServer())
    .post('/api/wf/' + path)
    .set(bearer(tokens[who]!))
    .send(body)
const item = (amount = '0.10') => ({
  expenseDate: '2026-11-01',
  expenseKind: 'transport',
  amount,
  description: 'Transport',
})
const body = (extra: object = {}) => ({
  reason: `Travel expense ${++seq}`,
  items: [item('0.10'), item('0.20')],
  initiatorPicks: { review: [first.users.alice] },
  ...extra,
})
const submit = async (extra: object = {}) =>
  (await call('owner', 'post', '', body(extra)).expect(201)).body.data
const row = (id: number) =>
  withTenant(first.id, () => ds.getRepository(OaExpenseClaim).findOneByOrFail({ id }))
const task = (instanceId: number, nodeId = 'review') =>
  withTenant(first.id, () =>
    ds.getRepository(WfTaskRow).findOneOrFail({ where: { instanceId, nodeId, state: 'pending' } }),
  )
const counts = () =>
  withTenant(first.id, async () => [
    await ds.getRepository(OaExpenseClaim).count(),
    await ds.getRepository(OaExpenseItem).count(),
    await ds.getRepository(WfInstanceRow).count(),
  ])
/** 并发测试按明确读锁边界放行，不依赖随机调度或固定等待。 */
function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

/** 独立的有效草稿用于验证从未绑定状态启动时的并发边界。 */
async function draft() {
  return withTenant(first.id, () =>
    ds.transaction(async (q) => {
      const claim = await q.getRepository(OaExpenseClaim).save({
        userId: first.ownerId,
        reason: 'Draft expense',
        totalAmount: '0.10',
        currency: 'CNY',
        state: 'draft',
        instanceId: null,
      })
      await q
        .getRepository(OaExpenseItem)
        .insert({ claimId: claim.id, ...item(), attachmentIds: [], sortNo: 1 })
      return claim
    }),
  )
}

const back = async (claim: { instanceId: number }) =>
  wf('reviewer', `tasks/${(await task(claim.instanceId)).id}/send-back`, { to: 'begin' }).expect(
    200,
  )

/** 测试发布新快照，绝不修改仍被实例引用的已发布版本。 */
async function publish(tenant: Pick<PeopledTenant, 'id'>, tree: WfBeginNode = expenseTree) {
  await withTenant(tenant.id, () =>
    ds.transaction(async (q) => {
      const model = await findRow(q, 'wf_model', { model_key: EXPENSE_MODEL })
      if (!model || model.deleted) throw new Error('Expense model missing')
      const compiled = compile(tree, EXPENSE_FIELDS)
      if (!compiled.ok) throw new Error('Invalid expense test tree')
      const [{ version }] = await q.query<{ version: number }[]>(
        'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM wf_version WHERE model_key = ? AND tenant_id = ?',
        [EXPENSE_MODEL, tenant.id],
      )
      const id = await insertRow(q, 'wf_version', {
        model_id: model.id,
        model_key: EXPENSE_MODEL,
        version,
        tree_json: compiled.flow.root,
        form_snapshot: { fields: EXPENSE_FIELDS },
      })
      await q.query(
        'UPDATE wf_model SET enabled = 1, current_version_id = ? WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
        [id, model.id, tenant.id],
      )
    }),
  )
}

beforeAll(async () => {
  app = await bootApp({ multiTenant: true })
  ds = app.get<DataSource>(getDataSourceToken())
  first = await createTenant(app, { users: true })
  second = await createTenant(app, { users: true })
  await ds.query('UPDATE iam_user SET password_changed_at = NOW(3) WHERE tenant_id IN (?, ?)', [
    first.id,
    second.id,
  ])
  for (const [who, id] of Object.entries({
    owner: first.ownerId,
    reviewer: first.users.alice,
    outsider: first.users.admin,
    foreign: second.ownerId,
    foreignReviewer: second.users.alice,
  })) {
    const signed = await signInDirect(app, id)
    if (!signed) throw new Error('Fixture sign-in failed')
    tokens[who] = signed.accessToken
  }
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await second?.dispose()
  await first?.dispose()
  await app?.close()
})

describe('expense request lifecycle', () => {
  it('initializes a disabled draft and preserves changed or deleted models', async () => {
    for (const tenant of [first, second]) {
      const [model] = await ds.query<
        { id: number; enabled: number; current_version_id: number | null }[]
      >(
        'SELECT id, enabled, current_version_id FROM wf_model WHERE model_key = ? AND tenant_id = ?',
        [EXPENSE_MODEL, tenant.id],
      )
      expect(model.enabled).toBe(1)
      expect(Number(model.current_version_id)).toBeGreaterThan(0)
      await ds.query('UPDATE wf_model SET enabled = 0 WHERE id = ? AND tenant_id = ?', [
        model.id,
        tenant.id,
      ])
      await call(tenant === first ? 'owner' : 'foreign', 'post', '', body()).expect(404)
      await ds.query(
        'UPDATE wf_model SET name = ?, deleted_at = NOW(3) WHERE id = ? AND tenant_id = ?',
        ['Custom expense', model.id, tenant.id],
      )
      await withTenant(tenant.id, () => ds.transaction(seedOaExpense))
      const [kept] = await ds.query<{ name: string; deleted_at: Date | null }[]>(
        'SELECT name, deleted_at FROM wf_model WHERE id = ? AND tenant_id = ?',
        [model.id, tenant.id],
      )
      expect(kept.name).toBe('Custom expense')
      expect(kept.deleted_at).not.toBeNull()
      await ds.query('UPDATE wf_model SET deleted_at = NULL WHERE id = ? AND tenant_id = ?', [
        model.id,
        tenant.id,
      ])
      await publish(tenant)
    }
  })

  it('saves exact totals and item dates and uses existing workflow visibility and approval', async () => {
    const claim = await submit()
    expect(claim).toMatchObject({
      userId: first.ownerId,
      totalAmount: '0.30',
      currency: 'CNY',
      state: 'in_review',
      attachmentIds: [],
    })
    expect(claim.items.map((line: { amount: string }) => line.amount)).toEqual(['0.10', '0.20'])
    expect(claim.items[0].expenseDate).toBe('2026-11-01')
    await call('reviewer', 'get', `/${claim.id}`).expect(200)
    await call('outsider', 'get', `/${claim.id}`).expect(404)
    await call('foreign', 'get', `/${claim.id}`).expect(404)
    expect((await call('foreign', 'get').expect(200)).body.data.items).toEqual([])
    const page = (await call('owner', 'get').expect(200)).body.data
    expect(page.items.some((x: { id: number }) => x.id === claim.id)).toBe(true)
    await wf('reviewer', `tasks/${(await task(claim.instanceId)).id}/approve`).expect(200)
    expect((await row(claim.id)).state).toBe('approved')
    await call('owner', 'put', `/${claim.id}`, { reason: 'Too late' }).expect(409)
  })

  it('keeps my list separate from another owner in the same tenant', async () => {
    const other = await withTenant(first.id, () =>
      ds.transaction(async (q) => {
        const claim = await q.getRepository(OaExpenseClaim).save({
          userId: first.users.alice,
          reason: 'Another employee expense',
          totalAmount: '5.00',
          currency: 'CNY',
          state: 'draft',
          instanceId: null,
        })
        await q
          .getRepository(OaExpenseItem)
          .insert({ claimId: claim.id, ...item('5.00'), attachmentIds: [], sortNo: 1 })
        return claim
      }),
    )
    const ownCount = await withTenant(first.id, () =>
      ds.getRepository(OaExpenseClaim).countBy({ userId: first.ownerId }),
    )
    const listed = (await call('owner', 'get').expect(200)).body.data
    expect(listed.total).toBe(ownCount)
    expect(listed.items.every((claim: { userId: number }) => claim.userId === first.ownerId)).toBe(
      true,
    )
    expect(listed.items.some((claim: { id: number }) => claim.id === other.id)).toBe(false)
    await call('owner', 'get', `/${other.id}`).expect(404)
  })

  it('reads the claim total and items from one snapshot while a returned claim changes', async () => {
    const claim = await submit()
    await back(claim)
    const captured = deferred(),
      resume = deferred()
    const find = Repository.prototype.findOneBy
    let paused = false
    vi.spyOn(Repository.prototype, 'findOneBy').mockImplementation(async function (
      this: Repository<ObjectLiteral>,
      where,
    ) {
      const found = await find.call(this, where)
      if (!paused && this.metadata.tableName === 'oa_expense_claim' && found?.id === claim.id) {
        paused = true
        captured.release()
        await resume.promise
      }
      return found
    })
    const reading = call('owner', 'get', `/${claim.id}`).then((response) => response)
    try {
      await captured.promise
      await call('owner', 'put', `/${claim.id}`, { items: [item('2.00')] }).expect(200)
    } finally {
      resume.release()
    }
    const snapshot = await reading
    expect(snapshot.status).toBe(200)
    expect(snapshot.body.data.totalAmount).toBe('0.30')
    expect(snapshot.body.data.items.map((line: { amount: string }) => line.amount)).toEqual([
      '0.10',
      '0.20',
    ])
    const current = (await call('owner', 'get', `/${claim.id}`).expect(200)).body.data
    expect(current.totalAmount).toBe('2.00')
    expect(current.items.map((line: { amount: string }) => line.amount)).toEqual(['2.00'])
  })

  it('rejects forged totals, identities, unsafe amounts and unbound attachments before writing', async () => {
    await call('outsider', 'get').expect(403)
    await call('outsider', 'post', '', body()).expect(403)
    const before = await counts()
    for (const extra of [
      { totalAmount: '0.01' },
      { currency: 'USD' },
      { userId: first.users.alice },
      { tenantId: second.id },
      { state: 'approved' },
      { items: [item('1.001')] },
      { items: [item('0')] },
      { items: [item('9999999999.99'), item('0.01')] },
      { attachmentIds: [12] },
      { items: [{ ...item(), attachmentIds: [12] }] },
      { items: [{ ...item(), id: 1 }] },
      { initiatorPicks: {} },
      { initiatorPicks: { review: [second.users.alice] } },
    ])
      await call('owner', 'post', '', body(extra)).expect(400)
    expect(await counts()).toEqual(before)
    await call('owner', 'get', '/999999999').expect(404)
    await call('owner', 'put', '/999999999', { reason: 'Missing' }).expect(404)
  })

  it('accepts only my approved trip in the same tenant as an expense reference', async () => {
    const makeTrip = (tenant: PeopledTenant, userId: number, state: 'approved' | 'in_review') =>
      withTenant(tenant.id, () =>
        ds.getRepository(OaTripRequest).save({
          userId,
          destination: 'Branch',
          startAt: new Date('2026-11-01T01:00:00Z'),
          endAt: new Date('2026-11-02T01:00:00Z'),
          reason: 'Trip fixture',
          state,
          instanceId: null,
        }),
      )
    const own = await makeTrip(first, first.ownerId, 'approved')
    const pending = await makeTrip(first, first.ownerId, 'in_review')
    const other = await makeTrip(first, first.users.alice, 'approved')
    const foreign = await makeTrip(second, second.ownerId, 'approved')
    expect((await submit({ tripId: own.id })).tripId).toBe(own.id)
    await call('owner', 'post', '', body({ tripId: pending.id })).expect(409)
    await call('owner', 'post', '', body({ tripId: other.id })).expect(404)
    await call('owner', 'post', '', body({ tripId: foreign.id })).expect(404)
    await call('owner', 'post', '', body({ tripId: 999999999 })).expect(404)
  })

  it('updates returned items atomically, soft-deletes removed rows and preserves omitted items and totals', async () => {
    const claim = await submit()
    await call('owner', 'put', `/${claim.id}`, { reason: 'Not returned' }).expect(409)
    await back(claim)
    await call('owner', 'put', `/${claim.id}`, {
      items: [{ ...item('1.10'), id: claim.items[0].id }, item('2.20')],
    }).expect(200)
    const current = (await call('owner', 'get', `/${claim.id}`).expect(200)).body.data
    expect(current.totalAmount).toBe('3.30')
    expect(current.items).toHaveLength(2)
    const removed = await withTenant(first.id, () =>
      ds
        .getRepository(OaExpenseItem)
        .findOne({ where: { id: claim.items[1].id }, withDeleted: true }),
    )
    expect(removed?.deletedAt).not.toBeNull()
    await call('owner', 'put', `/${claim.id}`, { reason: 'Only reason' }).expect(200)
    const unchanged = (await call('owner', 'get', `/${claim.id}`).expect(200)).body.data
    expect(unchanged.totalAmount).toBe('3.30')
    expect(unchanged.items).toEqual(current.items)
    await call('owner', 'put', `/${claim.id}`, { attachmentIds: [12] }).expect(400)
    await call('owner', 'put', `/${claim.id}`, {
      items: [{ ...item(), attachmentIds: [12] }],
    }).expect(400)
    const begin = await task(claim.instanceId, 'begin')
    await wf('owner', `tasks/${begin.id}/resubmit`, { formValues: { totalAmount: 0.01 } }).expect(
      200,
    )
    const instance = await withTenant(first.id, () =>
      ds.getRepository(WfInstanceRow).findOneByOrFail({ id: claim.instanceId }),
    )
    expect(instance.formValues.totalAmount).toBe(3.3)
    await call('owner', 'put', `/${claim.id}`, { reason: 'Consumed begin' }).expect(409)
  })

  it('refuses duplicate, foreign-claim and foreign-tenant item ids without changing either claim', async () => {
    const claim = await submit()
    const other = await submit()
    const foreign = (
      await call(
        'foreign',
        'post',
        '',
        body({ initiatorPicks: { review: [second.users.alice] } }),
      ).expect(201)
    ).body.data
    await back(claim)
    const before = (await call('owner', 'get', `/${claim.id}`).expect(200)).body.data
    await call('owner', 'put', `/${claim.id}`, {
      items: [
        { ...item(), id: claim.items[0].id },
        { ...item(), id: claim.items[0].id },
      ],
    }).expect(400)
    await call('owner', 'put', `/${claim.id}`, {
      items: [{ ...item(), id: other.items[0].id }],
    }).expect(404)
    await call('owner', 'put', `/${claim.id}`, {
      items: [{ ...item(), id: foreign.items[0].id }],
    }).expect(404)
    await call('foreign', 'put', `/${claim.id}`, { reason: 'Foreign claim' }).expect(404)
    expect((await call('owner', 'get', `/${claim.id}`).expect(200)).body.data).toEqual(before)
  })

  it('rolls back all items and the workflow when startup or business writeback fails', async () => {
    const handler = app.get(ExpenseWfHandler)
    const before = await counts()
    vi.spyOn(handler, 'onStateChange').mockRejectedValueOnce(new Error('Simulated expense failure'))
    await call('owner', 'post', '', body()).expect(500)
    expect(await counts()).toEqual(before)
    vi.restoreAllMocks()
    const claim = await submit()
    const pending = await task(claim.instanceId)
    vi.spyOn(handler, 'onStateChange').mockRejectedValueOnce(new Error('Simulated expense failure'))
    await wf('reviewer', `tasks/${pending.id}/approve`).expect(500)
    expect((await row(claim.id)).state).toBe('in_review')
    expect((await task(claim.instanceId)).id).toBe(pending.id)
  })

  it('rolls back earlier item edits when a later item write fails', async () => {
    const claim = await submit()
    await back(claim)
    const before = (await call('owner', 'get', `/${claim.id}`).expect(200)).body.data
    const update = Repository.prototype.update
    let writes = 0
    vi.spyOn(Repository.prototype, 'update').mockImplementation(async function (
      this: Repository<ObjectLiteral>,
      criteria,
      values,
    ) {
      if (this.metadata.tableName === 'oa_expense_item' && ++writes === 2)
        throw new Error('Simulated item failure')
      return update.call(this, criteria, values)
    })
    await call('owner', 'put', `/${claim.id}`, {
      items: claim.items.map((x: { id: number }) => ({ ...item('1.00'), id: x.id })),
    }).expect(500)
    expect((await call('owner', 'get', `/${claim.id}`).expect(200)).body.data).toEqual(before)
  })

  it('keeps approval pending if its business row is missing', async () => {
    const claim = await submit()
    const pending = await task(claim.instanceId)
    await ds.query('DELETE FROM oa_expense_claim WHERE id = ? AND tenant_id = ?', [
      claim.id,
      first.id,
    ])
    await wf('reviewer', `tasks/${pending.id}/approve`).expect(404)
    expect((await task(claim.instanceId)).id).toBe(pending.id)
  })

  it('edits and resubmits an existing instance after its published version is soft-deleted', async () => {
    const claim = await submit()
    await back(claim)
    const instance = await withTenant(first.id, () =>
      ds.getRepository(WfInstanceRow).findOneByOrFail({ id: claim.instanceId }),
    )
    await withTenant(first.id, () => ds.getRepository(WfVersion).softDelete(instance.versionId))
    try {
      await call('owner', 'put', `/${claim.id}`, { reason: 'Historical version edit' }).expect(200)
      await wf('owner', `tasks/${(await task(claim.instanceId, 'begin')).id}/resubmit`).expect(200)
      expect((await row(claim.id)).reason).toBe('Historical version edit')
      expect((await task(claim.instanceId)).nodeId).toBe('review')
    } finally {
      await withTenant(first.id, () => ds.getRepository(WfVersion).restore(instance.versionId))
    }
  })

  it('rejects a corrupted stored total instead of routing from a forged value', async () => {
    const claim = await submit()
    await back(claim)
    await withTenant(first.id, () =>
      ds.getRepository(OaExpenseClaim).update(claim.id, { totalAmount: '0.31' }),
    )
    const begin = await task(claim.instanceId, 'begin')
    await wf('owner', `tasks/${begin.id}/resubmit`, { formValues: { totalAmount: 0.31 } }).expect(
      409,
    )
    expect((await task(claim.instanceId, 'begin')).id).toBe(begin.id)
    await withTenant(first.id, () =>
      ds.getRepository(OaExpenseClaim).update(claim.id, { totalAmount: '0.30' }),
    )
    await withTenant(first.id, () =>
      ds.getRepository(OaExpenseClaim).update(claim.id, { currency: 'USD' }),
    )
    await wf('owner', `tasks/${begin.id}/resubmit`).expect(409)
    await withTenant(first.id, () =>
      ds.getRepository(OaExpenseClaim).update(claim.id, { currency: 'CNY' }),
    )
  })

  it('routes from changed exact expense items after return and resubmission', async () => {
    const fixed = (id: string, userId: number): WfReviewNode => ({
      id,
      type: 'review',
      name: id,
      assignee: { kind: 'users', ids: [userId] },
      sign: 'any',
      whenNobody: 'toManager',
      whenInitiatorIsReviewer: 'self',
      onReject: 'finish',
    })
    const tree: WfBeginNode = {
      ...expenseTree,
      next: {
        ...(expenseTree.next as WfReviewNode),
        next: {
          id: 'amount',
          type: 'fork',
          name: 'Amount',
          mode: 'exclusive',
          paths: [
            {
              id: 'large',
              name: 'Large',
              when: [[{ field: 'totalAmount', op: 'gt', value: 1000 }]],
              child: fixed('large-review', first.ownerId),
            },
            {
              id: 'other',
              name: 'Other',
              fallback: true,
              when: [],
              child: fixed('small-review', first.users.alice),
            },
          ],
        },
      },
    }
    await publish(first, tree)
    try {
      const claim = await submit()
      await back(claim)
      await call('owner', 'put', `/${claim.id}`, { items: [item('1500.00')] }).expect(200)
      await wf('owner', `tasks/${(await task(claim.instanceId, 'begin')).id}/resubmit`, {
        formValues: { totalAmount: 1 },
      }).expect(200)
      await wf('reviewer', `tasks/${(await task(claim.instanceId)).id}/approve`).expect(200)
      expect((await task(claim.instanceId, 'large-review')).assigneeId).toBe(first.ownerId)
    } finally {
      await publish(first)
    }
  })

  it('rechecks a consumed begin task after waiting behind a concurrent resubmission', async () => {
    const claim = await submit()
    await back(claim)
    const begin = await task(claim.instanceId, 'begin')
    const deferred = () => {
      let release!: () => void
      const promise = new Promise<void>((resolve) => {
        release = resolve
      })
      return { promise, release }
    }
    const inside = deferred(),
      resume = deferred(),
      snapshot = deferred()
    const handler = app.get(ExpenseWfHandler)
    const load = handler.loadFormValues.bind(handler)
    vi.spyOn(handler, 'loadFormValues').mockImplementation(async (...args) => {
      inside.release()
      await resume.promise
      return load(...args)
    })
    const find = Repository.prototype.findOneBy
    vi.spyOn(Repository.prototype, 'findOneBy').mockImplementation(async function (
      this: Repository<ObjectLiteral>,
      where,
    ) {
      const found = await find.call(this, where)
      if (this.metadata.tableName === 'oa_expense_claim' && found?.id === claim.id)
        snapshot.release()
      return found
    })
    const resubmit = wf('owner', `tasks/${begin.id}/resubmit`).then((x) => x)
    let edit: Promise<request.Response> | undefined
    try {
      await inside.promise
      edit = call('owner', 'put', `/${claim.id}`, { items: [item('999.00')] }).then((x) => x)
      await snapshot.promise
      resume.release()
      expect((await resubmit).status).toBe(200)
      expect((await edit).status).toBe(409)
      expect((await row(claim.id)).totalAmount).toBe('0.30')
    } finally {
      resume.release()
      await Promise.allSettled([resubmit, ...(edit ? [edit] : [])])
    }
  })

  it('serializes whole-claim updates and resubmission without duplicating approval', async () => {
    const claim = await submit()
    await back(claim)
    const begin = await task(claim.instanceId, 'begin')
    const result = await Promise.all([
      call('owner', 'put', `/${claim.id}`, { items: [item('10.00')] }),
      wf('owner', `tasks/${begin.id}/resubmit`),
    ])
    expect(result[1].status).toBe(200)
    expect([200, 409]).toContain(result[0].status)
    const current = await row(claim.id)
    const inst = await withTenant(first.id, () =>
      ds.getRepository(WfInstanceRow).findOneByOrFail({ id: claim.instanceId }),
    )
    expect(inst.formValues.totalAmount).toBe(Number(current.totalAmount))
    const pending = await task(claim.instanceId)
    const approvals = await Promise.all([
      wf('reviewer', `tasks/${pending.id}/approve`),
      wf('reviewer', `tasks/${pending.id}/approve`),
    ])
    expect(approvals.map((x) => x.status).sort()).toEqual([200, 409])
    expect((await row(claim.id)).state).toBe('approved')
  })

  it('keeps other owners outside both mutation and scoped administrator views', async () => {
    for (const code of [oaExpensePerms.modify, wfPerms.instance.view]) {
      const menu = await withTenant(first.id, () =>
        findRow(ds.manager, 'iam_menu', { kind: 'action', perms: code }),
      )
      if (!menu) throw new Error('Permission fixture missing')
      await ds.query('INSERT INTO iam_role_menus (role_id, menu_id, tenant_id) VALUES (?, ?, ?)', [
        first.roleId,
        menu.id,
        first.id,
      ])
    }
    await withTenant(first.id, () => app.get(PermVersion).bumpUsersOfRole(first.roleId))
    const claim = await submit()
    await call('outsider', 'put', `/${claim.id}`, { reason: 'Not mine' }).expect(404)
    await call('outsider', 'get', `/${claim.id}`).expect(404)
  })

  it('rejects a draft bound and returned after its editing snapshot was taken', async () => {
    const claim = await draft()
    const snapshot = deferred(),
      resume = deferred()
    const find = Repository.prototype.findOneBy
    let paused = false
    vi.spyOn(Repository.prototype, 'findOneBy').mockImplementation(async function (
      this: Repository<ObjectLiteral>,
      where,
    ) {
      const found = await find.call(this, where)
      if (
        !paused &&
        this.metadata.tableName === 'oa_expense_claim' &&
        found?.id === claim.id &&
        this.manager.queryRunner?.isTransactionActive
      ) {
        paused = true
        snapshot.release()
        await resume.promise
      }
      return found
    })
    const edit = call('owner', 'put', `/${claim.id}`, { reason: 'Late draft edit' }).then((x) => x)
    try {
      await snapshot.promise
      const started = await wf('owner', 'instances', {
        modelKey: EXPENSE_MODEL,
        businessKey: String(claim.id),
        initiatorPicks: { review: [first.users.alice] },
      }).expect(201)
      await back({ instanceId: started.body.data.id })
    } finally {
      resume.release()
    }
    expect((await edit).status).toBe(409)
    expect((await row(claim.id)).reason).toBe('Draft expense')
  })

  it('rechecks ownership after the editing snapshot is replaced by a current locked row', async () => {
    const claim = await draft()
    const snapshot = deferred(),
      resume = deferred()
    const find = Repository.prototype.findOneBy
    let paused = false
    vi.spyOn(Repository.prototype, 'findOneBy').mockImplementation(async function (
      this: Repository<ObjectLiteral>,
      where,
    ) {
      const found = await find.call(this, where)
      if (
        !paused &&
        this.metadata.tableName === 'oa_expense_claim' &&
        found?.id === claim.id &&
        this.manager.queryRunner?.isTransactionActive
      ) {
        paused = true
        snapshot.release()
        await resume.promise
      }
      return found
    })
    const edit = call('owner', 'put', `/${claim.id}`, { reason: 'Old owner edit' }).then((x) => x)
    try {
      await snapshot.promise
      await withTenant(first.id, () =>
        ds.getRepository(OaExpenseClaim).update(claim.id, { userId: first.users.alice }),
      )
    } finally {
      resume.release()
    }
    expect((await edit).status).toBe(404)
    expect((await row(claim.id)).reason).toBe('Draft expense')
  })

  it('waits for the instance before locking the business document during resubmission', async () => {
    const claim = await submit()
    await back(claim)
    const begin = await task(claim.instanceId, 'begin')
    const atForm = deferred(),
      resume = deferred(),
      atLock = deferred()
    const handler = app.get(ExpenseWfHandler)
    const load = handler.loadFormValues.bind(handler)
    vi.spyOn(handler, 'loadFormValues').mockImplementation(async (...args) => {
      atForm.release()
      await resume.promise
      return load(...args)
    })
    const resubmit = wf('owner', `tasks/${begin.id}/resubmit`).then((x) => x)
    await atForm.promise
    const find = Repository.prototype.findOne
    vi.spyOn(Repository.prototype, 'findOne').mockImplementation(async function (
      this: Repository<ObjectLiteral>,
      options,
    ) {
      if (options.lock?.mode === 'pessimistic_write') {
        if (this.metadata.tableName === 'wf_instance') atLock.release()
        if (this.metadata.tableName === 'oa_expense_claim') {
          const found = await find.call(this, options)
          atLock.release()
          return found
        }
      }
      return find.call(this, options)
    })
    const edit = call('owner', 'put', `/${claim.id}`, { items: [item('99.00')] }).then((x) => x)
    try {
      await atLock.promise
    } finally {
      resume.release()
    }
    expect((await resubmit).status).toBe(200)
    expect((await edit).status).toBe(409)
    expect((await row(claim.id)).totalAmount).toBe('0.30')
  })

  it('validates changed trip references before altering returned expense items', async () => {
    const makeTrip = (tenant: PeopledTenant, userId: number, state: 'approved' | 'in_review') =>
      withTenant(tenant.id, () =>
        ds.getRepository(OaTripRequest).save({
          userId,
          destination: 'Reference fixture',
          startAt: new Date('2026-11-01T01:00:00Z'),
          endAt: new Date('2026-11-02T01:00:00Z'),
          reason: 'Reference fixture',
          state,
          instanceId: null,
        }),
      )
    const approved = await makeTrip(first, first.ownerId, 'approved')
    const pending = await makeTrip(first, first.ownerId, 'in_review')
    const other = await makeTrip(first, first.users.alice, 'approved')
    const foreign = await makeTrip(second, second.ownerId, 'approved')
    const claim = await submit()
    await back(claim)
    await call('owner', 'put', `/${claim.id}`, { tripId: approved.id }).expect(200)
    const before = (await call('owner', 'get', `/${claim.id}`).expect(200)).body.data
    for (const [tripId, status] of [
      [pending.id, 409],
      [other.id, 404],
      [foreign.id, 404],
    ]) {
      await call('owner', 'put', `/${claim.id}`, {
        tripId,
        reason: 'Blocked reference edit',
        items: [{ ...item('12.00'), id: before.items[0].id }],
      }).expect(status!)
      expect((await call('owner', 'get', `/${claim.id}`).expect(200)).body.data).toEqual(before)
    }
    await call('owner', 'put', `/${claim.id}`, { tripId: null }).expect(200)
    expect((await row(claim.id)).tripId).toBeNull()
  })

  it('does not reuse a soft-deleted item id from the same expense claim', async () => {
    const claim = await submit()
    await back(claim)
    const removedId = claim.items[1].id
    await call('owner', 'put', `/${claim.id}`, {
      items: [{ ...item('0.10'), id: claim.items[0].id }],
    }).expect(200)
    const before = (await call('owner', 'get', `/${claim.id}`).expect(200)).body.data
    const deleted = await withTenant(first.id, () =>
      ds.getRepository(OaExpenseItem).findOne({ where: { id: removedId }, withDeleted: true }),
    )
    expect(deleted?.deletedAt).not.toBeNull()
    await call('owner', 'put', `/${claim.id}`, {
      items: [{ ...item('4.00'), id: removedId }],
    }).expect(404)
    expect((await call('owner', 'get', `/${claim.id}`).expect(200)).body.data).toEqual(before)
    expect(before.totalAmount).toBe('0.10')
    expect(before.items).toHaveLength(1)
  })

  it('rejects generic workflow starts for another owner and repeated bound claims', async () => {
    const unbound = await draft()
    const claim = await submit()
    const count = () => withTenant(first.id, () => ds.getRepository(WfInstanceRow).count())
    const before = await count()
    await wf('reviewer', 'instances', {
      modelKey: EXPENSE_MODEL,
      businessKey: String(unbound.id),
      initiatorPicks: { review: [first.ownerId] },
    }).expect(404)
    const repeat = () =>
      wf('owner', 'instances', {
        modelKey: EXPENSE_MODEL,
        businessKey: String(claim.id),
        initiatorPicks: { review: [first.users.alice] },
        formValues: { ignoredSequence: ++seq },
      })
    await repeat().expect(409)
    await wf('reviewer', `tasks/${(await task(claim.instanceId)).id}/approve`).expect(200)
    await repeat().expect(409)
    expect(await count()).toBe(before)
    expect((await row(unbound.id)).instanceId).toBeNull()
  })

  it('rejects unsafe business keys before querying a legitimate draft repository', async () => {
    const legitimate = await draft()
    await withTenant(first.id, () =>
      ds.transaction(async (q) => {
        const repo = q.getRepository(OaExpenseClaim)
        const find = vi.spyOn(repo, 'findOne').mockResolvedValue(legitimate)
        try {
          for (const key of ['001', '1e3', '-1', '9007199254740992'])
            await expect(
              app.get(ExpenseWfHandler).assertStartable(key, first.ownerId, q),
            ).rejects.toMatchObject({ err: Err.NOT_FOUND })
          expect(find).not.toHaveBeenCalled()
          await app.get(ExpenseWfHandler).assertStartable(String(legitimate.id), first.ownerId, q)
          expect(find).toHaveBeenCalledTimes(1)
        } finally {
          find.mockRestore()
        }
      }),
    )
  })

  it('keeps the returned claim pending when its selected reviewer is disabled', async () => {
    await publish(first, expenseTree)
    const claim = await submit()
    await back(claim)
    const begin = await task(claim.instanceId, 'begin')
    const [reviewer] = await ds.query<{ enabled: number }[]>(
      'SELECT enabled FROM iam_user WHERE id = ? AND tenant_id = ?',
      [first.users.alice, first.id],
    )
    if (!reviewer) throw new Error('Reviewer fixture missing')
    try {
      await ds.query('UPDATE iam_user SET enabled = 0 WHERE id = ? AND tenant_id = ?', [
        first.users.alice,
        first.id,
      ])
      await wf('owner', `tasks/${begin.id}/resubmit`).expect(422)
      expect((await task(claim.instanceId, 'begin')).id).toBe(begin.id)
      expect((await row(claim.id)).state).toBe('in_review')
      const pending = await withTenant(first.id, () =>
        ds
          .getRepository(WfTaskRow)
          .find({ where: { instanceId: claim.instanceId, state: 'pending' } }),
      )
      expect(pending.map((entry) => entry.nodeId)).toEqual(['begin'])
    } finally {
      await ds.query('UPDATE iam_user SET enabled = ? WHERE id = ? AND tenant_id = ?', [
        reviewer.enabled,
        first.users.alice,
        first.id,
      ])
    }
  })

  it('requires the workflow feature even if the office permissions are in the package', async () => {
    const menus = await ds.query<{ id: number }[]>(
      'SELECT id FROM iam_menu WHERE deleted_at IS NULL AND (route_name = ? OR perms LIKE ?)',
      ['oa', 'oa.%'],
    )
    const pack = await createPackage(app, { menuIds: menus.map((menu) => menu.id) })
    const limited = await createTenant(app, { packageId: pack.id })
    try {
      await ds.query(
        'UPDATE iam_user SET password_changed_at = NOW(3) WHERE id = ? AND tenant_id = ?',
        [limited.ownerId, limited.id],
      )
      await publish(limited)
      const signed = await signInDirect(app, limited.ownerId)
      if (!signed) throw new Error('Limited sign-in failed')
      tokens.limited = signed.accessToken
      await call('limited', 'get').expect(404)
      await call(
        'limited',
        'post',
        '',
        body({ initiatorPicks: { review: [limited.ownerId] } }),
      ).expect(404)
      await call('limited', 'get', '/1').expect(404)
      await call('limited', 'put', '/1', { reason: 'Blocked' }).expect(404)
    } finally {
      await limited.dispose()
      await pack.dispose()
      delete tokens.limited
    }
  })
})
