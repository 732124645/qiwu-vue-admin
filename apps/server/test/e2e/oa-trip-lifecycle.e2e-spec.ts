import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import {
  compile,
  Err,
  oaTripPerms,
  wfPerms,
  type WfBeginNode,
  type WfReviewNode,
} from '@qiwu/shared'
import request from 'supertest'
import { type DataSource, type EntityManager, type ObjectLiteral, Repository } from 'typeorm'
import { PermVersion } from '../../src/core/auth/perm-version.js'
import { withTenant } from '../../src/core/context/tenant.js'
import { findRow, insertRow } from '../../src/db/seeds/upsert.js'
import { seedOaTrip, tripTree } from '../../src/db/seeds/project/oa-trip.seed.js'
import {
  TripWfHandler,
  TRIP_FIELDS,
  TRIP_MODEL,
} from '../../src/modules/oa/trip/trip-wf.handler.js'
import { OaTripRequest } from '../../src/modules/oa/trip/trip.entity.js'
import { TripService } from '../../src/modules/oa/trip/trip.service.js'
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
const MISSING = 999_999_999
const URL = '/api/oa/trips'
const call = (who: string, method: 'get' | 'post' | 'put', path = '', data?: object) => {
  const req = request(app.getHttpServer())
    [method](URL + path)
    .set(bearer(tokens[who]!))
  return data === undefined ? req : req.send(data)
}
const wf = (who: string, path: string, data: object = {}) =>
  request(app.getHttpServer())
    .post('/api/wf/' + path)
    .set(bearer(tokens[who]!))
    .send(data)
const body = (extra: object = {}) => ({
  destination: 'North office',
  startAt: '2026-11-01T01:00:00Z',
  endAt: '2026-11-03T10:00:00Z',
  estimatedAmount: '0.30',
  reason: `Supplier visit ${++seq}`,
  initiatorPicks: { review: [first.users.alice] },
  ...extra,
})
const submit = async (extra: object = {}) =>
  (await call('owner', 'post', '', body(extra)).expect(201)).body.data
const row = (id: number) =>
  withTenant(first.id, () => ds.getRepository(OaTripRequest).findOneByOrFail({ id }))
const task = (instanceId: number, nodeId = 'review') =>
  withTenant(first.id, () =>
    ds.getRepository(WfTaskRow).findOneOrFail({
      where: { instanceId, nodeId, state: 'pending' },
    }),
  )

/** 每次发布独立快照，运行中实例继续保留原版本，测试不改已有版本。 */
async function publish(tenant: Pick<PeopledTenant, 'id'>, tree: WfBeginNode = tripTree) {
  await withTenant(tenant.id, () =>
    ds.transaction(async (q) => {
      const model = await findRow(q, 'wf_model', { model_key: TRIP_MODEL })
      if (!model || model.deleted) throw new Error('Trip model missing')
      const compiled = compile(tree, TRIP_FIELDS)
      if (!compiled.ok) throw new Error('Invalid test trip tree')
      const [{ version }] = await q.query<{ version: number }[]>(
        'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM wf_version WHERE model_key = ? AND tenant_id = ?',
        [TRIP_MODEL, tenant.id],
      )
      const id = await insertRow(q, 'wf_version', {
        model_id: model.id,
        model_key: TRIP_MODEL,
        version,
        tree_json: compiled.flow.root,
        form_snapshot: { fields: TRIP_FIELDS },
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
    if (!signed) throw new Error('Unable to sign in fixture')
    tokens[who] = signed.accessToken
  }
})

afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await second?.dispose()
  await first?.dispose()
  await app?.close()
})

describe('trip request lifecycle', () => {
  it('seeds a published process per tenant and preserves administrator changes and deletion', async () => {
    for (const tenant of [first, second]) {
      const [model] = await ds.query<
        { id: number; enabled: number; current_version_id: number | null }[]
      >(
        'SELECT id, enabled, current_version_id FROM wf_model WHERE model_key = ? AND tenant_id = ?',
        [TRIP_MODEL, tenant.id],
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
        ['Custom trip', model.id, tenant.id],
      )
      await withTenant(tenant.id, () => ds.transaction(seedOaTrip))
      const [kept] = await ds.query<{ name: string; deleted_at: Date | null }[]>(
        'SELECT name, deleted_at FROM wf_model WHERE id = ? AND tenant_id = ?',
        [model.id, tenant.id],
      )
      expect(kept.name).toBe('Custom trip')
      expect(kept.deleted_at).not.toBeNull()
      await ds.query('UPDATE wf_model SET deleted_at = NULL WHERE id = ? AND tenant_id = ?', [
        model.id,
        tenant.id,
      ])
      await publish(tenant)
    }
  })

  it('submits through the existing workflow and lets only the owner and participant read the document', async () => {
    const trip = await submit()
    expect(trip).toMatchObject({
      userId: first.ownerId,
      state: 'in_review',
      estimatedAmount: '0.30',
      attachmentIds: [],
    })
    const pending = await task(trip.instanceId)
    expect(pending.assigneeId).toBe(first.users.alice)
    await call('reviewer', 'get', `/${trip.id}`).expect(200)
    await call('outsider', 'get', `/${trip.id}`).expect(404)
    await call('foreign', 'get', `/${trip.id}`).expect(404)
    const page = (await call('owner', 'get').expect(200)).body.data
    expect(page.items.some((item: { id: number }) => item.id === trip.id)).toBe(true)
    expect((await call('foreign', 'get').expect(200)).body.data.items).toEqual([])
    await wf('reviewer', `tasks/${pending.id}/approve`).expect(200)
    expect((await row(trip.id)).state).toBe('approved')
    await call('owner', 'put', `/${trip.id}`, { reason: 'Too late' }).expect(409)
  })

  it('keeps another applicant in the same tenant out of my list', async () => {
    const mine = await submit()
    const other = await withTenant(first.id, () =>
      ds.getRepository(OaTripRequest).save({
        userId: first.users.admin,
        deptId: first.deptId,
        destination: 'Another applicant',
        startAt: new Date('2026-11-01T01:00:00Z'),
        endAt: new Date('2026-11-03T10:00:00Z'),
        reason: 'Other applicant draft',
        state: 'draft',
        instanceId: null,
      }),
    )
    const page = (await call('owner', 'get', '?pageSize=200').expect(200)).body.data
    expect(page.items.some((item: { id: number }) => item.id === mine.id)).toBe(true)
    expect(page.items.some((item: { id: number }) => item.id === other.id)).toBe(false)
    expect(page.items.every((item: { userId: number }) => item.userId === first.ownerId)).toBe(true)
  })

  it('enforces permissions, ownership, validation and tenant boundaries before any business write', async () => {
    await call('outsider', 'get').expect(403)
    await call('outsider', 'post', '', body()).expect(403)
    await call('owner', 'post', '', body({ userId: first.users.alice })).expect(400)
    await call('owner', 'post', '', body({ state: 'approved' })).expect(400)
    await call('owner', 'post', '', body({ endAt: '2026-11-01T01:00:00Z' })).expect(400)
    await call('owner', 'post', '', body({ estimatedAmount: 0.3 })).expect(400)
    await call('owner', 'post', '', body({ attachmentIds: [12] })).expect(400)
    const before = await withTenant(first.id, () => ds.getRepository(OaTripRequest).count())
    await call('owner', 'post', '', body({ initiatorPicks: {} })).expect(400)
    await call(
      'owner',
      'post',
      '',
      body({ initiatorPicks: { review: [second.users.alice] } }),
    ).expect(400)
    expect(await withTenant(first.id, () => ds.getRepository(OaTripRequest).count())).toBe(before)
    const trip = await submit()
    await call('outsider', 'put', `/${trip.id}`, { reason: 'Other owner' }).expect(403)
    await call('foreign', 'put', `/${trip.id}`, { reason: 'Other tenant' }).expect(404)
    await call('owner', 'get', `/${MISSING}`).expect(404)
    await call('owner', 'put', `/${MISSING}`, { reason: 'Missing' }).expect(404)
  })

  it('starts no second workflow for a bound document and ignores forged workflow form values', async () => {
    const trip = await submit()
    await withTenant(first.id, async () => {
      await expect(
        ds.transaction((q) =>
          app.get(TripWfHandler).assertStartable(String(trip.id), first.ownerId, q),
        ),
      ).rejects.toMatchObject({ err: Err.CONFLICT })
      await expect(
        ds.transaction((q) => app.get(TripWfHandler).assertStartable('1e3', first.ownerId, q)),
      ).rejects.toMatchObject({ err: Err.NOT_FOUND })
      await expect(
        ds.transaction((q) =>
          app.get(TripWfHandler).assertStartable(String(trip.id), first.users.alice, q),
        ),
      ).rejects.toMatchObject({ err: Err.NOT_FOUND })
    })
    const inst = await withTenant(first.id, () =>
      ds.getRepository(WfInstanceRow).findOneByOrFail({ id: trip.instanceId }),
    )
    expect(inst.formValues.destination).toBe(trip.destination)
  })

  it('rejects decimal aliases of a real draft key and unsafe integers before querying it', async () => {
    const draft = await withTenant(first.id, () =>
      ds.getRepository(OaTripRequest).save({
        userId: first.ownerId,
        destination: 'Canonical key only',
        startAt: new Date('2026-11-01T01:00:00Z'),
        endAt: new Date('2026-11-03T10:00:00Z'),
        reason: 'Key validation draft',
        state: 'draft',
        instanceId: null,
      }),
    )
    for (const key of [`0${draft.id}`, `${draft.id}e0`])
      await wf('owner', 'instances', {
        modelKey: TRIP_MODEL,
        businessKey: key,
        formValues: {},
        initiatorPicks: { review: [first.users.alice] },
      }).expect(404)
    expect((await row(draft.id)).instanceId).toBeNull()
    const findOne = vi.fn().mockResolvedValue(null)
    const tx = { getRepository: () => ({ findOne }) } as unknown as EntityManager
    const handler = app.get(TripWfHandler)
    for (const key of ['9007199254740992', '9007199254740993']) {
      await expect(handler.assertStartable(key, first.ownerId, tx)).rejects.toMatchObject({
        err: Err.NOT_FOUND,
      })
      expect(findOne).not.toHaveBeenCalled()
    }
  })

  it('allows only an owner draft or a pending begin task to edit and validates partial times against stored values', async () => {
    const draft = await withTenant(first.id, () =>
      ds.getRepository(OaTripRequest).save({
        userId: first.ownerId,
        destination: 'Original',
        startAt: new Date('2026-11-01T01:00:00Z'),
        endAt: new Date('2026-11-03T10:00:00Z'),
        reason: 'Draft',
        state: 'draft',
        instanceId: null,
      }),
    )
    await call('owner', 'put', `/${draft.id}`, { endAt: '2026-10-31T01:00:00Z' }).expect(400)
    await call('owner', 'put', `/${draft.id}`, { startAt: '2026-11-04T01:00:00Z' }).expect(400)
    await call('owner', 'put', `/${draft.id}`, { attachmentIds: [12] }).expect(400)
    await call('owner', 'put', `/${draft.id}`, { reason: 'Changed draft' }).expect(200)
    expect((await row(draft.id)).reason).toBe('Changed draft')
    const trip = await submit()
    await call('owner', 'put', `/${trip.id}`, { reason: 'Not returned' }).expect(409)
    const pending = await task(trip.instanceId)
    await wf('reviewer', `tasks/${pending.id}/send-back`, { to: 'begin' }).expect(200)
    await call('owner', 'put', `/${trip.id}`, {
      destination: 'South office',
      estimatedAmount: '0.10',
    }).expect(200)
    expect(await row(trip.id)).toMatchObject({
      destination: 'South office',
      estimatedAmount: '0.10',
    })
    const begin = await task(trip.instanceId, 'begin')
    await wf('owner', `tasks/${begin.id}/resubmit`, {
      formValues: { destination: 'Forged' },
    }).expect(200)
    const inst = await withTenant(first.id, () =>
      ds.getRepository(WfInstanceRow).findOneByOrFail({ id: trip.instanceId }),
    )
    expect(inst.formValues.destination).toBe('South office')
    await call('owner', 'put', `/${trip.id}`, { reason: 'Already resubmitted' }).expect(409)
  })

  it('keeps returned requests editable when their running version was soft-deleted', async () => {
    const trip = await submit()
    const inst = await withTenant(first.id, () =>
      ds.getRepository(WfInstanceRow).findOneByOrFail({ id: trip.instanceId }),
    )
    await publish(first)
    await ds.query('UPDATE wf_version SET deleted_at = NOW(3) WHERE id = ? AND tenant_id = ?', [
      inst.versionId,
      first.id,
    ])
    try {
      await wf('reviewer', `tasks/${(await task(trip.instanceId)).id}/send-back`, {
        to: 'begin',
      }).expect(200)
      await call('owner', 'put', `/${trip.id}`, { destination: 'Updated historic version' }).expect(
        200,
      )
      await wf('owner', `tasks/${(await task(trip.instanceId, 'begin')).id}/resubmit`).expect(200)
      const latest = await withTenant(first.id, () =>
        ds.getRepository(WfInstanceRow).findOneByOrFail({ id: trip.instanceId }),
      )
      expect(latest.formValues.destination).toBe('Updated historic version')
      await wf('reviewer', `tasks/${(await task(trip.instanceId)).id}/approve`).expect(200)
      expect((await row(trip.id)).state).toBe('approved')
    } finally {
      await ds.query('UPDATE wf_version SET deleted_at = NULL WHERE id = ? AND tenant_id = ?', [
        inst.versionId,
        first.id,
      ])
    }
  })

  it('rolls back creation and approval when synchronous business writeback fails', async () => {
    const handler = app.get(TripWfHandler)
    const before = await withTenant(first.id, () => ds.getRepository(OaTripRequest).count())
    vi.spyOn(handler, 'onStateChange').mockRejectedValueOnce(
      new Error('Simulated business failure'),
    )
    await call('owner', 'post', '', body()).expect(500)
    expect(await withTenant(first.id, () => ds.getRepository(OaTripRequest).count())).toBe(before)
    vi.restoreAllMocks()
    const trip = await submit()
    const pending = await task(trip.instanceId)
    vi.spyOn(handler, 'onStateChange').mockRejectedValueOnce(
      new Error('Simulated business failure'),
    )
    await wf('reviewer', `tasks/${pending.id}/approve`).expect(500)
    expect((await row(trip.id)).state).toBe('in_review')
    expect((await task(trip.instanceId)).id).toBe(pending.id)
  })

  it('keeps the workflow pending when its business row cannot be written back', async () => {
    const trip = await submit()
    const pending = await task(trip.instanceId)
    await ds.query('DELETE FROM oa_trip_request WHERE id = ? AND tenant_id = ?', [
      trip.id,
      first.id,
    ])
    await wf('reviewer', `tasks/${pending.id}/approve`).expect(404)
    const inst = await withTenant(first.id, () =>
      ds.getRepository(WfInstanceRow).findOneByOrFail({ id: trip.instanceId }),
    )
    expect(inst.state).toBe('running')
    expect((await task(trip.instanceId)).id).toBe(pending.id)
  })

  it('serializes edits and resubmission and rejects a second approval without duplicating results', async () => {
    const trip = await submit()
    const review = await task(trip.instanceId)
    await wf('reviewer', `tasks/${review.id}/send-back`, { to: 'begin' }).expect(200)
    const begin = await task(trip.instanceId, 'begin')
    const results = await Promise.all([
      call('owner', 'put', `/${trip.id}`, { destination: 'Concurrent destination' }),
      wf('owner', `tasks/${begin.id}/resubmit`),
    ])
    expect(results[1].status).toBe(200)
    expect([200, 409]).toContain(results[0].status)
    const current = await row(trip.id)
    const inst = await withTenant(first.id, () =>
      ds.getRepository(WfInstanceRow).findOneByOrFail({ id: trip.instanceId }),
    )
    expect(inst.formValues.destination).toBe(current.destination)
    const next = await task(trip.instanceId)
    const approvals = await Promise.all([
      wf('reviewer', `tasks/${next.id}/approve`),
      wf('reviewer', `tasks/${next.id}/approve`),
    ])
    expect(approvals.map((x) => x.status).sort()).toEqual([200, 409])
    expect((await row(trip.id)).state).toBe('approved')
  })

  it('rejects another owner even with modify and scoped workflow-view permissions', async () => {
    for (const code of [oaTripPerms.modify, wfPerms.instance.view]) {
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
    const trip = await submit()
    await call('outsider', 'put', `/${trip.id}`, { reason: 'Not my request' }).expect(404)
    // 申请人的根部门不在此角色的本部门范围，管理员查看也不能越界。
    await call('outsider', 'get', `/${trip.id}`).expect(404)
  })

  it('uses the changed document for conditional routing after return and resubmission', async () => {
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
      ...tripTree,
      next: {
        ...(tripTree.next as WfReviewNode),
        next: {
          id: 'by-destination',
          type: 'fork',
          name: 'Destination',
          mode: 'exclusive',
          paths: [
            {
              id: 'south',
              name: 'South',
              when: [[{ field: 'destination', op: 'eq', value: 'South office' }]],
              child: fixed('changed', first.ownerId),
            },
            {
              id: 'other',
              name: 'Other',
              fallback: true,
              when: [],
              child: fixed('unchanged', first.users.alice),
            },
          ],
        },
      },
    }
    await publish(first, tree)
    try {
      const trip = await submit()
      await wf('reviewer', `tasks/${(await task(trip.instanceId)).id}/send-back`, {
        to: 'begin',
      }).expect(200)
      await call('owner', 'put', `/${trip.id}`, { destination: 'South office' }).expect(200)
      await wf('owner', `tasks/${(await task(trip.instanceId, 'begin')).id}/resubmit`, {
        formValues: { destination: 'North office' },
      }).expect(200)
      await wf('reviewer', `tasks/${(await task(trip.instanceId)).id}/approve`).expect(200)
      expect((await task(trip.instanceId, 'changed')).assigneeId).toBe(first.ownerId)
    } finally {
      await publish(first)
    }
  })

  it('rechecks the consumed begin task after waiting for a concurrent resubmission', async () => {
    const trip = await submit()
    await wf('reviewer', `tasks/${(await task(trip.instanceId)).id}/send-back`, {
      to: 'begin',
    }).expect(200)
    const begin = await task(trip.instanceId, 'begin')
    const deferred = () => {
      let release!: () => void
      const promise = new Promise<void>((resolve) => {
        release = resolve
      })
      return { promise, release }
    }
    const insideResubmit = deferred()
    const resume = deferred()
    const snapshotRead = deferred()
    const handler = app.get(TripWfHandler)
    const load = handler.loadFormValues.bind(handler)
    vi.spyOn(handler, 'loadFormValues').mockImplementation(async (...args) => {
      insideResubmit.release()
      await resume.promise
      return load(...args)
    })
    const find = Repository.prototype.findOneBy
    vi.spyOn(Repository.prototype, 'findOneBy').mockImplementation(async function (
      this: Repository<ObjectLiteral>,
      where,
    ) {
      const found = await find.call(this, where)
      if (this.metadata.tableName === 'oa_trip_request' && found?.id === trip.id)
        snapshotRead.release()
      return found
    })
    const resubmission = wf('owner', `tasks/${begin.id}/resubmit`).then((response) => response)
    let update: Promise<request.Response> | undefined
    try {
      await insideResubmit.promise
      update = call('owner', 'put', `/${trip.id}`, { destination: 'Too late' }).then(
        (response) => response,
      )
      await snapshotRead.promise
      resume.release()
      expect((await resubmission).status).toBe(200)
      expect((await update).status).toBe(409)
      expect((await row(trip.id)).destination).toBe('North office')
    } finally {
      resume.release()
      await Promise.allSettled([resubmission, ...(update ? [update] : [])])
    }
  })

  it('waits for the instance before locking a document while resubmission reads it', async () => {
    const trip = await submit()
    await wf('reviewer', `tasks/${(await task(trip.instanceId)).id}/send-back`, {
      to: 'begin',
    }).expect(200)
    const begin = await task(trip.instanceId, 'begin')
    const handler = app.get(TripWfHandler)
    const loadValues = handler.loadFormValues.bind(handler)
    let atForm!: () => void
    let releaseForm!: () => void
    let atEditLock!: () => void
    const readingForm = new Promise<void>((resolve) => {
      atForm = resolve
    })
    const resumeForm = new Promise<void>((resolve) => {
      releaseForm = resolve
    })
    const attemptingEditLock = new Promise<void>((resolve) => {
      atEditLock = resolve
    })
    vi.spyOn(handler, 'loadFormValues').mockImplementation(async (key, tx) => {
      if (key === String(trip.id)) {
        atForm()
        await resumeForm
      }
      return loadValues(key, tx)
    })
    const resubmitting = wf('owner', `tasks/${begin.id}/resubmit`).then((response) => response)
    await readingForm
    const findOne = Repository.prototype.findOne
    vi.spyOn(Repository.prototype, 'findOne').mockImplementation(async function (
      this: Repository<ObjectLiteral>,
      options,
    ) {
      if (options.lock?.mode === 'pessimistic_write') {
        if (this.metadata.tableName === 'wf_instance') atEditLock()
        if (this.metadata.tableName === 'oa_trip_request') {
          const locked = await findOne.call(this, options)
          atEditLock()
          return locked
        }
      }
      return findOne.call(this, options)
    })
    const editing = call('owner', 'put', `/${trip.id}`, {
      destination: 'Edited after resubmit',
    }).then((response) => response)
    try {
      await attemptingEditLock
    } finally {
      releaseForm()
    }
    expect((await resubmitting).status).toBe(200)
    expect((await editing).status).toBe(409)
    const current = await row(trip.id)
    const inst = await withTenant(first.id, () =>
      ds.getRepository(WfInstanceRow).findOneByOrFail({ id: trip.instanceId }),
    )
    expect(current.destination).toBe('North office')
    expect(inst.formValues.destination).toBe('North office')
  })

  it('keeps a sent-back request pending when its selected reviewer is disabled', async () => {
    await publish(first)
    const trip = await submit()
    await wf('reviewer', `tasks/${(await task(trip.instanceId)).id}/send-back`, {
      to: 'begin',
    }).expect(200)
    const begin = await task(trip.instanceId, 'begin')
    try {
      await ds.query('UPDATE iam_user SET enabled = 0 WHERE id = ? AND tenant_id = ?', [
        first.users.alice,
        first.id,
      ])
      const result = await wf('owner', `tasks/${begin.id}/resubmit`).expect(422)
      expect(result.body.code).toBe(Err.WF_NO_ASSIGNEE.code)
      expect((await task(trip.instanceId, 'begin')).id).toBe(begin.id)
      expect((await row(trip.id)).state).toBe('in_review')
      const inst = await withTenant(first.id, () =>
        ds.getRepository(WfInstanceRow).findOneByOrFail({ id: trip.instanceId }),
      )
      expect(inst.state).toBe('running')
    } finally {
      await ds.query('UPDATE iam_user SET enabled = 1 WHERE id = ? AND tenant_id = ?', [
        first.users.alice,
        first.id,
      ])
    }
  })

  it('requires workflow in the package even when office permissions are present', async () => {
    const menus = await ds.query<{ id: number }[]>(
      'SELECT id FROM iam_menu WHERE deleted_at IS NULL AND (route_name = ? OR perms LIKE ?)',
      ['oa', 'oa.%'],
    )
    const limitedPackage = await createPackage(app, { menuIds: menus.map((menu) => menu.id) })
    const limited = await createTenant(app, { packageId: limitedPackage.id })
    try {
      await ds.query(
        'UPDATE iam_user SET password_changed_at = NOW(3) WHERE id = ? AND tenant_id = ?',
        [limited.ownerId, limited.id],
      )
      await publish(limited)
      const signed = await signInDirect(app, limited.ownerId)
      if (!signed) throw new Error('Limited fixture sign-in failed')
      tokens.limited = signed.accessToken
      const draft = await withTenant(limited.id, () =>
        ds.getRepository(OaTripRequest).save({
          userId: limited.ownerId,
          destination: 'Own draft',
          startAt: new Date('2026-11-01T01:00:00Z'),
          endAt: new Date('2026-11-03T10:00:00Z'),
          reason: 'Own draft',
          state: 'draft',
          instanceId: null,
        }),
      )
      await call('limited', 'get').expect(404)
      await call('limited', 'get', `/${draft.id}`).expect(404)
      await call('limited', 'put', `/${draft.id}`, { reason: 'Blocked' }).expect(404)
      await call(
        'limited',
        'post',
        '',
        body({ initiatorPicks: { review: [limited.ownerId] } }),
      ).expect(404)
    } finally {
      await limited.dispose()
      await limitedPackage.dispose()
      delete tokens.limited
    }
  })

  it('allows an expense to reference only my approved trip in this tenant', async () => {
    const trip = await submit()
    const service = app.get(TripService)
    await withTenant(first.id, async () => {
      await expect(
        ds.transaction((q) => service.assertExpenseReference(trip.id, first.ownerId, q)),
      ).rejects.toMatchObject({ err: Err.CONFLICT })
    })
    await wf('reviewer', `tasks/${(await task(trip.instanceId)).id}/approve`).expect(200)
    await withTenant(first.id, () =>
      ds.transaction((q) => service.assertExpenseReference(trip.id, first.ownerId, q)),
    )
    await withTenant(first.id, async () => {
      await expect(
        ds.transaction((q) => service.assertExpenseReference(trip.id, first.users.alice, q)),
      ).rejects.toMatchObject({ status: 404 })
    })
    await withTenant(second.id, async () => {
      await expect(
        ds.transaction((q) => service.assertExpenseReference(trip.id, second.ownerId, q)),
      ).rejects.toMatchObject({ status: 404 })
    })
  })
})
