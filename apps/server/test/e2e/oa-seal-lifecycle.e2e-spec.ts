import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import {
  compile,
  Err,
  oaSealPerms,
  wfPerms,
  type WfBeginNode,
  type WfReviewNode,
} from '@qiwu/shared'
import request from 'supertest'
import { type DataSource, type ObjectLiteral, Repository } from 'typeorm'
import { PermVersion } from '../../src/core/auth/perm-version.js'
import { withTenant } from '../../src/core/context/tenant.js'
import { findRow, insertRow } from '../../src/db/seeds/upsert.js'
import { seedOaSeal, sealTree } from '../../src/db/seeds/project/oa-seal.seed.js'
import {
  SealWfHandler,
  SEAL_FIELDS,
  SEAL_MODEL,
} from '../../src/modules/oa/seal/seal-wf.handler.js'
import { OaSealRequest } from '../../src/modules/oa/seal/seal.entity.js'
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
const URL = '/api/oa/seal-requests'
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
  sealKind: 'company',
  documentName: 'North office agreement',
  purpose: `Service agreement ${++seq}`,
  copies: 2,
  expectedDate: '2026-11-03',
  initiatorPicks: { review: [first.users.alice] },
  ...extra,
})
const submit = async (extra: object = {}) =>
  (await call('owner', 'post', '', body(extra)).expect(201)).body.data
const row = (id: number) =>
  withTenant(first.id, () => ds.getRepository(OaSealRequest).findOneByOrFail({ id }))
const task = (instanceId: number, nodeId = 'review') =>
  withTenant(first.id, () =>
    ds.getRepository(WfTaskRow).findOneOrFail({
      where: { instanceId, nodeId, state: 'pending' },
    }),
  )

/** 每次发布独立快照，运行中实例继续保留原版本，测试不改已有版本。 */
async function publish(tenant: Pick<PeopledTenant, 'id'>, tree: WfBeginNode = sealTree) {
  await withTenant(tenant.id, () =>
    ds.transaction(async (q) => {
      const model = await findRow(q, 'wf_model', { model_key: SEAL_MODEL })
      if (!model || model.deleted) throw new Error('Seal model missing')
      const compiled = compile(tree, SEAL_FIELDS)
      if (!compiled.ok) throw new Error('Invalid test seal tree')
      const [{ version }] = await q.query<{ version: number }[]>(
        'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM wf_version WHERE model_key = ? AND tenant_id = ?',
        [SEAL_MODEL, tenant.id],
      )
      const id = await insertRow(q, 'wf_version', {
        model_id: model.id,
        model_key: SEAL_MODEL,
        version,
        tree_json: compiled.flow.root,
        form_snapshot: { fields: SEAL_FIELDS },
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

describe('seal request lifecycle', () => {
  it('seeds a published process per tenant and preserves administrator changes and deletion', async () => {
    for (const tenant of [first, second]) {
      const [model] = await ds.query<
        { id: number; enabled: number; current_version_id: number | null }[]
      >(
        'SELECT id, enabled, current_version_id FROM wf_model WHERE model_key = ? AND tenant_id = ?',
        [SEAL_MODEL, tenant.id],
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
        ['Custom seal', model.id, tenant.id],
      )
      await withTenant(tenant.id, () => ds.transaction(seedOaSeal))
      const [kept] = await ds.query<{ name: string; deleted_at: Date | null }[]>(
        'SELECT name, deleted_at FROM wf_model WHERE id = ? AND tenant_id = ?',
        [model.id, tenant.id],
      )
      expect(kept.name).toBe('Custom seal')
      expect(kept.deleted_at).not.toBeNull()
      await ds.query('UPDATE wf_model SET deleted_at = NULL WHERE id = ? AND tenant_id = ?', [
        model.id,
        tenant.id,
      ])
      await publish(tenant)
    }
  })

  it('submits through the existing workflow and lets only the owner and participant read the document', async () => {
    const seal = await submit()
    expect(seal).toMatchObject({
      userId: first.ownerId,
      state: 'in_review',
      copies: 2,
      attachmentIds: [],
    })
    const pending = await task(seal.instanceId)
    expect(pending.assigneeId).toBe(first.users.alice)
    await call('reviewer', 'get', `/${seal.id}`).expect(200)
    await call('outsider', 'get', `/${seal.id}`).expect(404)
    await call('foreign', 'get', `/${seal.id}`).expect(404)
    const page = (await call('owner', 'get').expect(200)).body.data
    expect(page.items.some((item: { id: number }) => item.id === seal.id)).toBe(true)
    expect((await call('foreign', 'get').expect(200)).body.data.items).toEqual([])
    await wf('reviewer', `tasks/${pending.id}/approve`).expect(200)
    expect((await row(seal.id)).state).toBe('approved')
    await call('owner', 'put', `/${seal.id}`, { purpose: 'Too late' }).expect(409)
  })

  it('mirrors rejection, applicant cancellation and administrator termination without implying a seal was used', async () => {
    const rejected = await submit()
    await wf('reviewer', `tasks/${(await task(rejected.instanceId)).id}/reject`, {
      comment: 'Revise document',
    }).expect(200)
    expect((await row(rejected.id)).state).toBe('rejected')
    const canceled = await submit()
    await wf('owner', `instances/${canceled.instanceId}/cancel`).expect(200)
    expect((await row(canceled.id)).state).toBe('canceled')
    const terminated = await submit()
    await wf('owner', `instances/${terminated.instanceId}/terminate`, {
      comment: 'Request no longer needed',
    }).expect(200)
    expect((await row(terminated.id)).state).toBe('canceled')
  })

  it('enforces permissions, ownership, validation and tenant boundaries before any business write', async () => {
    await call('outsider', 'get').expect(403)
    await call('outsider', 'post', '', body()).expect(403)
    await call('owner', 'post', '', body({ userId: first.users.alice })).expect(400)
    await call('owner', 'post', '', body({ state: 'approved' })).expect(400)
    await call('owner', 'post', '', body({ copies: 0 })).expect(400)
    await call('owner', 'post', '', body({ expectedDate: '2026-02-30' })).expect(400)
    await call('owner', 'post', '', body({ attachmentIds: [12] })).expect(400)
    const before = await withTenant(first.id, () => ds.getRepository(OaSealRequest).count())
    await call('owner', 'post', '', body({ initiatorPicks: {} })).expect(400)
    await call(
      'owner',
      'post',
      '',
      body({ initiatorPicks: { review: [second.users.alice] } }),
    ).expect(400)
    expect(await withTenant(first.id, () => ds.getRepository(OaSealRequest).count())).toBe(before)
    const seal = await submit()
    await call('outsider', 'put', `/${seal.id}`, { purpose: 'Other owner' }).expect(403)
    await call('foreign', 'put', `/${seal.id}`, { purpose: 'Other tenant' }).expect(404)
    await call('owner', 'get', `/${MISSING}`).expect(404)
    await call('owner', 'put', `/${MISSING}`, { purpose: 'Missing' }).expect(404)
  })

  it('starts no second workflow for a bound document and ignores forged workflow form values', async () => {
    const seal = await submit()
    await withTenant(first.id, async () => {
      await expect(
        ds.transaction((q) =>
          app.get(SealWfHandler).assertStartable(String(seal.id), first.ownerId, q),
        ),
      ).rejects.toMatchObject({ err: Err.CONFLICT })
      await expect(
        ds.transaction((q) => app.get(SealWfHandler).assertStartable('1e3', first.ownerId, q)),
      ).rejects.toMatchObject({ err: Err.NOT_FOUND })
      await expect(
        ds.transaction((q) =>
          app.get(SealWfHandler).assertStartable(String(seal.id), first.users.alice, q),
        ),
      ).rejects.toMatchObject({ err: Err.NOT_FOUND })
    })
    const inst = await withTenant(first.id, () =>
      ds.getRepository(WfInstanceRow).findOneByOrFail({ id: seal.instanceId }),
    )
    expect(inst.formValues.copies).toBe(seal.copies)
  })

  it('allows only an owner draft or a pending begin task to edit the document', async () => {
    const draft = await withTenant(first.id, () =>
      ds.getRepository(OaSealRequest).save({
        userId: first.ownerId,
        sealKind: 'company',
        documentName: 'Draft agreement',
        purpose: 'Draft',
        copies: 2,
        expectedDate: '2026-11-03',
        state: 'draft',
        instanceId: null,
      }),
    )
    await call('owner', 'put', `/${draft.id}`, { copies: 10000 }).expect(400)
    await call('owner', 'put', `/${draft.id}`, { expectedDate: '2026-02-30' }).expect(400)
    await call('owner', 'put', `/${draft.id}`, { attachmentIds: [12] }).expect(400)
    await call('owner', 'put', `/${draft.id}`, { purpose: 'Changed draft' }).expect(200)
    expect((await row(draft.id)).purpose).toBe('Changed draft')
    const seal = await submit()
    await call('owner', 'put', `/${seal.id}`, { purpose: 'Not returned' }).expect(409)
    await wf('reviewer', `tasks/${(await task(seal.instanceId)).id}/send-back`, {
      to: 'begin',
    }).expect(200)
    await call('owner', 'put', `/${seal.id}`, { copies: 6 }).expect(200)
    const begin = await task(seal.instanceId, 'begin')
    await wf('owner', `tasks/${begin.id}/resubmit`, { formValues: { copies: 1 } }).expect(200)
    const inst = await withTenant(first.id, () =>
      ds.getRepository(WfInstanceRow).findOneByOrFail({ id: seal.instanceId }),
    )
    expect(inst.formValues.copies).toBe(6)
    await call('owner', 'put', `/${seal.id}`, { purpose: 'Already resubmitted' }).expect(409)
  })

  it('rolls back creation and approval when synchronous business writeback fails', async () => {
    const handler = app.get(SealWfHandler)
    const before = await withTenant(first.id, () => ds.getRepository(OaSealRequest).count())
    vi.spyOn(handler, 'onStateChange').mockRejectedValueOnce(
      new Error('Simulated business failure'),
    )
    await call('owner', 'post', '', body()).expect(500)
    expect(await withTenant(first.id, () => ds.getRepository(OaSealRequest).count())).toBe(before)
    vi.restoreAllMocks()
    const seal = await submit()
    const pending = await task(seal.instanceId)
    vi.spyOn(handler, 'onStateChange').mockRejectedValueOnce(
      new Error('Simulated business failure'),
    )
    await wf('reviewer', `tasks/${pending.id}/approve`).expect(500)
    expect((await row(seal.id)).state).toBe('in_review')
    expect((await task(seal.instanceId)).id).toBe(pending.id)
  })

  it('keeps the workflow pending when its business row cannot be written back', async () => {
    const seal = await submit()
    const pending = await task(seal.instanceId)
    await ds.query('DELETE FROM oa_seal_request WHERE id = ? AND tenant_id = ?', [
      seal.id,
      first.id,
    ])
    await wf('reviewer', `tasks/${pending.id}/approve`).expect(404)
    const inst = await withTenant(first.id, () =>
      ds.getRepository(WfInstanceRow).findOneByOrFail({ id: seal.instanceId }),
    )
    expect(inst.state).toBe('running')
    expect((await task(seal.instanceId)).id).toBe(pending.id)
  })

  it('serializes edits and resubmission and rejects a second approval without duplicating results', async () => {
    const seal = await submit()
    const review = await task(seal.instanceId)
    await wf('reviewer', `tasks/${review.id}/send-back`, { to: 'begin' }).expect(200)
    const begin = await task(seal.instanceId, 'begin')
    const results = await Promise.all([
      call('owner', 'put', `/${seal.id}`, { copies: 5 }),
      wf('owner', `tasks/${begin.id}/resubmit`),
    ])
    expect(results[1].status).toBe(200)
    expect([200, 409]).toContain(results[0].status)
    const current = await row(seal.id)
    const inst = await withTenant(first.id, () =>
      ds.getRepository(WfInstanceRow).findOneByOrFail({ id: seal.instanceId }),
    )
    expect(inst.formValues.copies).toBe(current.copies)
    const next = await task(seal.instanceId)
    const approvals = await Promise.all([
      wf('reviewer', `tasks/${next.id}/approve`),
      wf('reviewer', `tasks/${next.id}/approve`),
    ])
    expect(approvals.map((x) => x.status).sort()).toEqual([200, 409])
    expect((await row(seal.id)).state).toBe('approved')
  })

  it('rejects another owner even with modify and scoped workflow-view permissions', async () => {
    for (const code of [oaSealPerms.modify, wfPerms.instance.view]) {
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
    const seal = await submit()
    await call('outsider', 'put', `/${seal.id}`, { purpose: 'Not my request' }).expect(404)
    // 申请人的根部门不在此角色的本部门范围，管理员查看也不能越界。
    await call('outsider', 'get', `/${seal.id}`).expect(404)
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
      ...sealTree,
      next: {
        ...(sealTree.next as WfReviewNode),
        next: {
          id: 'by-copies',
          type: 'fork',
          name: 'Copies',
          mode: 'exclusive',
          paths: [
            {
              id: 'south',
              name: 'South',
              when: [[{ field: 'copies', op: 'gt', value: 5 }]],
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
      const seal = await submit()
      await wf('reviewer', `tasks/${(await task(seal.instanceId)).id}/send-back`, {
        to: 'begin',
      }).expect(200)
      await call('owner', 'put', `/${seal.id}`, { copies: 6 }).expect(200)
      await wf('owner', `tasks/${(await task(seal.instanceId, 'begin')).id}/resubmit`, {
        formValues: { copies: 2 },
      }).expect(200)
      await wf('reviewer', `tasks/${(await task(seal.instanceId)).id}/approve`).expect(200)
      expect((await task(seal.instanceId, 'changed')).assigneeId).toBe(first.ownerId)
    } finally {
      await publish(first)
    }
  })

  it('rechecks the consumed begin task after waiting for a concurrent resubmission', async () => {
    const seal = await submit()
    await wf('reviewer', `tasks/${(await task(seal.instanceId)).id}/send-back`, {
      to: 'begin',
    }).expect(200)
    const begin = await task(seal.instanceId, 'begin')
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
    const handler = app.get(SealWfHandler)
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
      if (this.metadata.tableName === 'oa_seal_request' && found?.id === seal.id)
        snapshotRead.release()
      return found
    })
    const resubmission = wf('owner', `tasks/${begin.id}/resubmit`).then((response) => response)
    let update: Promise<request.Response> | undefined
    try {
      await insideResubmit.promise
      update = call('owner', 'put', `/${seal.id}`, { copies: 9 }).then((response) => response)
      await snapshotRead.promise
      resume.release()
      expect((await resubmission).status).toBe(200)
      expect((await update).status).toBe(409)
      expect((await row(seal.id)).copies).toBe(2)
    } finally {
      resume.release()
      await Promise.allSettled([resubmission, ...(update ? [update] : [])])
    }
  })

  it('edits a returned request on its original soft-deleted workflow version', async () => {
    const seal = await submit()
    const instance = await withTenant(first.id, () =>
      ds.getRepository(WfInstanceRow).findOneByOrFail({ id: seal.instanceId }),
    )
    await ds.query('UPDATE wf_version SET deleted_at = NOW(3) WHERE id = ? AND tenant_id = ?', [
      instance.versionId,
      first.id,
    ])
    try {
      await wf('reviewer', `tasks/${(await task(seal.instanceId)).id}/send-back`, {
        to: 'begin',
      }).expect(200)
      await call('owner', 'put', `/${seal.id}`, { purpose: 'Historical version update' }).expect(
        200,
      )
      await wf('owner', `tasks/${(await task(seal.instanceId, 'begin')).id}/resubmit`).expect(200)
      expect((await row(seal.id)).purpose).toBe('Historical version update')
    } finally {
      await ds.query('UPDATE wf_version SET deleted_at = NULL WHERE id = ? AND tenant_id = ?', [
        instance.versionId,
        first.id,
      ])
    }
  })

  it('waits for the instance before locking a document while resubmission reads it', async () => {
    const seal = await submit()
    await wf('reviewer', `tasks/${(await task(seal.instanceId)).id}/send-back`, {
      to: 'begin',
    }).expect(200)
    const begin = await task(seal.instanceId, 'begin')
    const handler = app.get(SealWfHandler)
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
      if (key === String(seal.id)) {
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
        if (this.metadata.tableName === 'oa_seal_request') {
          const locked = await findOne.call(this, options)
          atEditLock()
          return locked
        }
      }
      return findOne.call(this, options)
    })
    const editing = call('owner', 'put', `/${seal.id}`, {
      copies: 9,
    }).then((response) => response)
    try {
      await attemptingEditLock
    } finally {
      releaseForm()
    }
    expect((await resubmitting).status).toBe(200)
    expect((await editing).status).toBe(409)
    const current = await row(seal.id)
    const inst = await withTenant(first.id, () =>
      ds.getRepository(WfInstanceRow).findOneByOrFail({ id: seal.instanceId }),
    )
    expect(current.copies).toBe(2)
    expect(inst.formValues.copies).toBe(2)
  })

  it('keeps a sent-back request pending when its selected reviewer is disabled', async () => {
    await publish(first)
    const seal = await submit()
    await wf('reviewer', `tasks/${(await task(seal.instanceId)).id}/send-back`, {
      to: 'begin',
    }).expect(200)
    const begin = await task(seal.instanceId, 'begin')
    try {
      await ds.query('UPDATE iam_user SET enabled = 0 WHERE id = ? AND tenant_id = ?', [
        first.users.alice,
        first.id,
      ])
      const result = await wf('owner', `tasks/${begin.id}/resubmit`).expect(422)
      expect(result.body.code).toBe(Err.WF_NO_ASSIGNEE.code)
      expect((await task(seal.instanceId, 'begin')).id).toBe(begin.id)
      expect((await row(seal.id)).state).toBe('in_review')
      const inst = await withTenant(first.id, () =>
        ds.getRepository(WfInstanceRow).findOneByOrFail({ id: seal.instanceId }),
      )
      expect(inst.state).toBe('running')
    } finally {
      await ds.query('UPDATE iam_user SET enabled = 1 WHERE id = ? AND tenant_id = ?', [
        first.users.alice,
        first.id,
      ])
    }
  })

  it('keeps another applicant out of my list even within the same tenant', async () => {
    const before = (await call('owner', 'get').expect(200)).body.data
    const other = await withTenant(first.id, () =>
      ds.getRepository(OaSealRequest).save({
        userId: first.users.alice,
        sealKind: 'company',
        documentName: 'Other agreement',
        purpose: 'Private matter',
        copies: 2,
        expectedDate: '2026-11-03',
        state: 'draft',
        instanceId: null,
      }),
    )
    const after = (await call('owner', 'get').expect(200)).body.data
    expect(after.total).toBe(before.total)
    expect(after.items.every((entry: { userId: number }) => entry.userId === first.ownerId)).toBe(
      true,
    )
    expect(after.items.some((entry: { id: number }) => entry.id === other.id)).toBe(false)
  })

  it('rejects noncanonical and unsafe keys before querying a legitimate draft repository', async () => {
    const legitimate = await withTenant(first.id, () =>
      ds.getRepository(OaSealRequest).save({
        userId: first.ownerId,
        sealKind: 'company',
        documentName: 'Draft agreement',
        purpose: 'Draft',
        copies: 2,
        expectedDate: '2026-11-03',
        state: 'draft',
        instanceId: null,
      }),
    )
    await withTenant(first.id, () =>
      ds.transaction(async (q) => {
        const repo = q.getRepository(OaSealRequest)
        const find = vi.spyOn(repo, 'findOne').mockResolvedValue(legitimate)
        try {
          for (const key of [
            `00${legitimate.id}`,
            `${legitimate.id}.0`,
            `${legitimate.id}e0`,
            '9007199254740992',
          ])
            await expect(
              app.get(SealWfHandler).assertStartable(key, first.ownerId, q),
            ).rejects.toMatchObject({ err: Err.NOT_FOUND })
          expect(find).not.toHaveBeenCalled()
          await app.get(SealWfHandler).assertStartable(String(legitimate.id), first.ownerId, q)
          expect(find).toHaveBeenCalledTimes(1)
        } finally {
          find.mockRestore()
        }
      }),
    )
  })

  it('refuses invalid stored values at workflow start and after merging a partial edit', async () => {
    const invalid = await withTenant(first.id, () =>
      ds.getRepository(OaSealRequest).save({
        userId: first.ownerId,
        sealKind: 'company',
        documentName: 'Historical agreement',
        purpose: 'Historical draft',
        copies: 0,
        expectedDate: '2026-11-03',
        state: 'draft',
        instanceId: null,
      }),
    )
    const before = await withTenant(first.id, () => ds.getRepository(WfInstanceRow).count())
    await wf('owner', 'instances', {
      modelKey: SEAL_MODEL,
      businessKey: String(invalid.id),
      initiatorPicks: { review: [first.users.alice] },
    }).expect(400)
    await call('owner', 'put', `/${invalid.id}`, { purpose: 'Must not persist' }).expect(400)
    expect((await row(invalid.id)).purpose).toBe('Historical draft')
    expect((await row(invalid.id)).instanceId).toBeNull()
    expect(await withTenant(first.id, () => ds.getRepository(WfInstanceRow).count())).toBe(before)
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
        ds.getRepository(OaSealRequest).save({
          userId: limited.ownerId,
          sealKind: 'company',
          documentName: 'Own draft',
          purpose: 'Own draft',
          copies: 2,
          expectedDate: '2026-11-03',
          state: 'draft',
          instanceId: null,
        }),
      )
      await call('limited', 'get').expect(404)
      await call('limited', 'get', `/${draft.id}`).expect(404)
      await call('limited', 'put', `/${draft.id}`, { purpose: 'Blocked' }).expect(404)
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
})
