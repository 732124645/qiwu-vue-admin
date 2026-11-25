import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import { type FormSchema, type WfBeginNode, type WfReviewNode } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { withTenant } from '../../src/core/context/tenant.js'
import { findRow, insertRow } from '../../src/db/seeds/upsert.js'
import {
  GENERIC_MODEL,
  genericSchema,
  genericTree,
  seedOaGeneric,
} from '../../src/db/seeds/project/oa-generic.seed.js'
import { WfInstanceRow, WfTaskRow } from '../../src/modules/workflow/runtime/wf-runtime.entity.js'
import { bearer } from '../setup/auth.js'
import { bootApp, createTenant, signInDirect, type PeopledTenant } from '../setup/tenants.js'

let app: NestExpressApplication
let ds: DataSource
let first: PeopledTenant
let second: PeopledTenant
const tokens: Record<string, string> = {}
let seq = 0
const call = (who: string, method: 'get' | 'post' | 'put', path: string, body?: object) => {
  const req = request(app.getHttpServer())
    [method]('/api/wf/' + path)
    .set(bearer(tokens[who]!))
  return body === undefined ? (method === 'post' ? req.send({}) : req) : req.send(body)
}
const values = (extra: object = {}) => ({
  title: `Office matter ${++seq}`,
  description: 'Private matter',
  expectedDate: '2026-11-03',
  ...extra,
})
const start = (extra: object = {}) =>
  call('owner', 'post', 'instances', {
    modelKey: GENERIC_MODEL,
    initiatorPicks: { review: [first.users.alice] },
    formValues: values(extra),
  })
const detail = async (who: string, id: number) =>
  (await call(who, 'get', `instances/${id}`).expect(200)).body.data
const pending = (id: number, nodeId = 'review') =>
  withTenant(first.id, () =>
    ds.getRepository(WfTaskRow).findOneByOrFail({ instanceId: id, nodeId, state: 'pending' }),
  )
const model = async (tenant: PeopledTenant) =>
  withTenant(tenant.id, () => findRow(ds.manager, 'wf_model', { model_key: GENERIC_MODEL }))

/** 通过真实管理接口发布新快照，只有模型管理员才能启用该版本。 */
async function publish(who = 'owner', tree: WfBeginNode = genericTree) {
  const tenant = who === 'foreign' ? second : first
  const saved = await model(tenant)
  if (!saved || saved.deleted) throw new Error('General model missing')
  const version = (
    await call(who, 'post', `models/${saved.id}/versions`, {
      tree: { ...tree, name: `Begin ${++seq}` },
    }).expect(201)
  ).body.data
  await call(who, 'put', `models/${saved.id}/enabled`, { enabled: true }).expect(200)
  return { id: saved.id, version }
}

/** 元数据夹具验证流程绑定，文件传输本身由存储模块的独立用例覆盖。 */
async function file(tenant: PeopledTenant, userId: number, tag = 'wf.attachment') {
  const [{ id: storageId }] = await ds.query<{ id: number }[]>(
    'SELECT id FROM fs_storage WHERE deleted_at IS NULL ORDER BY id LIMIT 1',
  )
  const id = await withTenant(tenant.id, () =>
    insertRow(ds.manager, 'fs_object', {
      storage_id: storageId,
      object_key: `generic-${tenant.id}-${++seq}.txt`,
      original_name: 'request.txt',
      mime: 'text/plain',
      size: 10,
      is_public: 0,
      biz_tag: tag,
      uploader_id: userId,
    }),
  )
  return `${id}/request.txt`
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
  })) {
    const signed = await signInDirect(app, id)
    if (!signed) throw new Error('Unable to sign in general request fixture')
    tokens[who] = signed.accessToken
  }
})
afterAll(async () => {
  await second?.dispose()
  await first?.dispose()
  await app?.close()
})

describe('general office approval on dynamic forms', () => {
  it('seeds published tenant forms and preserves edited or deleted forms and models', async () => {
    for (const tenant of [first, second]) {
      const saved = await model(tenant)
      if (!saved) throw new Error('General model missing')
      const [before] = await ds.query<
        { enabled: number; current_version_id: number | null; form_id: number }[]
      >(
        'SELECT enabled, current_version_id, form_id FROM wf_model WHERE id = ? AND tenant_id = ?',
        [saved.id, tenant.id],
      )
      expect(before.enabled).toBe(1)
      expect(Number(before.current_version_id)).toBeGreaterThan(0)
      await ds.query(
        'UPDATE wf_model SET name = ?, deleted_at = NOW(3) WHERE id = ? AND tenant_id = ?',
        ['My general approval', saved.id, tenant.id],
      )
      await ds.query('UPDATE wf_form SET name = ? WHERE id = ? AND tenant_id = ?', [
        'My general form',
        before.form_id,
        tenant.id,
      ])
      await withTenant(tenant.id, () => ds.transaction(seedOaGeneric))
      const [kept] = await ds.query<{ name: string; deleted_at: Date | null }[]>(
        'SELECT name, deleted_at FROM wf_model WHERE id = ? AND tenant_id = ?',
        [saved.id, tenant.id],
      )
      expect(kept.name).toBe('My general approval')
      expect(kept.deleted_at).not.toBeNull()
      const [keptForm] = await ds.query<{ name: string }[]>(
        'SELECT name FROM wf_form WHERE id = ? AND tenant_id = ?',
        [before.form_id, tenant.id],
      )
      expect(keptForm.name).toBe('My general form')
      await ds.query('UPDATE wf_model SET deleted_at = NULL WHERE id = ? AND tenant_id = ?', [
        saved.id,
        tenant.id,
      ])
    }
    await ds.query('UPDATE wf_model SET enabled = 0 WHERE model_key = ? AND tenant_id = ?', [
      GENERIC_MODEL,
      first.id,
    ])
    await start().expect(404)
    await publish()
    await publish('foreign')
  })

  it('does not adopt an existing administrator-owned form when its default model is missing', async () => {
    const other = await createTenant(app)
    try {
      const saved = await withTenant(other.id, () =>
        findRow(ds.manager, 'wf_model', { model_key: GENERIC_MODEL }),
      )
      if (!saved) throw new Error('General model fixture missing')
      const [existing] = await ds.query<{ form_id: number }[]>(
        'SELECT form_id FROM wf_model WHERE id = ? AND tenant_id = ?',
        [saved.id, other.id],
      )
      await ds.query('DELETE FROM wf_model WHERE id = ? AND tenant_id = ?', [saved.id, other.id])
      const custom = { rule: [{ type: 'input', field: 'custom', title: 'My field' }], option: {} }
      await ds.query('UPDATE wf_form SET schema_json = ? WHERE id = ? AND tenant_id = ?', [
        JSON.stringify(custom),
        existing.form_id,
        other.id,
      ])
      await withTenant(other.id, () => ds.transaction(seedOaGeneric))
      expect(
        await withTenant(other.id, () =>
          findRow(ds.manager, 'wf_model', { model_key: GENERIC_MODEL }),
        ),
      ).toBeUndefined()
      const [kept] = await ds.query<{ schema_json: object }[]>(
        'SELECT schema_json FROM wf_form WHERE id = ? AND tenant_id = ?',
        [existing.form_id, other.id],
      )
      expect(kept.schema_json).toEqual(custom)
    } finally {
      await other.dispose()
    }
  })

  it('publishes the existing sanitized schema with both languages and stable snapshot fields', async () => {
    const saved = await model(first)
    const current = (await call('owner', 'get', `models/${saved!.id}`).expect(200)).body.data
    expect(current.formKind).toBe('dynamic')
    const info = (await call('owner', 'get', `models/${GENERIC_MODEL}/start-info`).expect(200)).body
      .data
    expect(info.schema.rule.map((rule: { field: string }) => rule.field)).toEqual([
      'title',
      'description',
      'expectedDate',
      'attachments',
    ])
    expect(info.schema.option.language['zh-cn'].title).toBe('事项名称')
    expect(info.schema.option.language.en.title).toBe('Subject')
    expect(genericSchema.rule.length).toBe(4)
  })

  it('runs start, return, edited resubmission and approval without a separate business table', async () => {
    const created = (await start().expect(201)).body.data
    const review = await pending(created.id)
    await call('reviewer', 'post', `tasks/${review.id}/send-back`, { to: 'begin' }).expect(200)
    const begin = await pending(created.id, 'begin')
    await call('owner', 'post', `tasks/${begin.id}/resubmit`, {
      formValues: {
        title: 'Revised matter',
        description: 'Revised explanation',
        expectedDate: '2026-11-04',
      },
    }).expect(200)
    const again = await pending(created.id)
    await call('reviewer', 'post', `tasks/${again.id}/approve`).expect(200)
    const done = await detail('owner', created.id)
    expect(done.state).toBe('approved')
    expect(done.formValues).toMatchObject({
      title: 'Revised matter',
      description: 'Revised explanation',
      expectedDate: '2026-11-04',
    })
  })

  it('keeps hidden values out of reviewer details and ignores writes to read-only fields', async () => {
    const tree: WfBeginNode = {
      ...genericTree,
      access: { title: 'edit', description: 'edit', expectedDate: 'edit', attachments: 'edit' },
      next: {
        ...(genericTree.next as WfReviewNode),
        access: { title: 'read', description: 'hide', expectedDate: 'read', attachments: 'hide' },
      },
    }
    await publish('owner', tree)
    try {
      const created = (await start().expect(201)).body.data
      const read = await detail('reviewer', created.id)
      expect(read.formValues).not.toHaveProperty('description')
      expect(read.schema.rule.map((rule: { field: string }) => rule.field)).not.toContain(
        'description',
      )
      const review = await pending(created.id)
      await call('reviewer', 'post', `tasks/${review.id}/approve`, {
        formValues: { title: 'Forged', description: 'Forged' },
      }).expect(200)
      expect((await detail('owner', created.id)).formValues).toMatchObject({
        title: expect.stringContaining('Office matter'),
        description: 'Private matter',
      })
    } finally {
      await publish()
    }
  })

  it('rejects invalid values and inaccessible models, instances and tasks', async () => {
    const saved = await model(first)
    await call('outsider', 'post', `models/${saved!.id}/versions`, {}).expect(403)
    await start({ title: '' }).expect(400)
    await start({ expectedDate: 'not-a-date' }).expect(400)
    const created = (await start().expect(201)).body.data
    await call('foreign', 'get', `instances/${created.id}`).expect(404)
    await call('outsider', 'get', `instances/${created.id}`).expect(404)
    const review = await pending(created.id)
    await call('foreign', 'post', `tasks/${review.id}/approve`).expect(404)
    await call('outsider', 'post', `tasks/${review.id}/approve`).expect(404)
    await call('foreign', 'get', `models/${saved!.id}`).expect(404)
    await call('foreign', 'post', `models/${saved!.id}/versions`, {}).expect(404)
    await call('owner', 'post', 'instances', {
      modelKey: 'missing-office-model',
      formValues: values(),
    }).expect(404)
  })

  it('binds only my unbound workflow attachments and rejects reused, foreign or unowned references', async () => {
    const own = await file(first, first.ownerId)
    const created = (await start({ attachments: own }).expect(201)).body.data
    const [bound] = await ds.query<{ biz_ref: string }[]>(
      'SELECT biz_ref FROM fs_object WHERE id = ? AND tenant_id = ?',
      [Number(own.split('/')[0]), first.id],
    )
    expect(bound.biz_ref).toBe(`wf:${created.id}`)
    for (const bad of [
      own,
      await file(first, first.users.admin),
      await file(second, second.ownerId),
      await file(first, first.ownerId, 'attachment'),
      '999999999/unknown.txt',
    ])
      await start({ attachments: bad }).expect(400)
    const [instance] = await withTenant(first.id, () =>
      ds.getRepository(WfInstanceRow).findBy({ id: created.id }),
    )
    expect(instance.formValues.attachments).toBe(own)
  })

  it('does not overwrite a running form snapshot when the draft form changes', async () => {
    const created = (await start().expect(201)).body.data
    const before = (await detail('owner', created.id)).schema as FormSchema
    const saved = await model(first)
    const [m] = await ds.query<{ form_id: number }[]>(
      'SELECT form_id FROM wf_model WHERE id = ? AND tenant_id = ?',
      [saved!.id, first.id],
    )
    const changed: FormSchema = {
      rule: [{ type: 'input', field: 'replacement', title: 'Replacement' }],
      option: {},
    }
    await call('owner', 'put', `forms/${m.form_id}`, { schemaJson: changed }).expect(200)
    expect((await detail('owner', created.id)).schema).toEqual(before)
    await call('owner', 'put', `forms/${m.form_id}`, { schemaJson: genericSchema }).expect(200)
  })
})

it('keeps a returned general request pending when its selected reviewer is disabled', async () => {
  await publish('owner', genericTree)
  const created = (await start().expect(201)).body.data
  await call('reviewer', 'post', `tasks/${(await pending(created.id)).id}/send-back`, {
    to: 'begin',
  }).expect(200)
  const begin = await pending(created.id, 'begin')
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
    await call('owner', 'post', `tasks/${begin.id}/resubmit`).expect(422)
    expect((await pending(created.id, 'begin')).id).toBe(begin.id)
    const inst = await withTenant(first.id, () =>
      ds.getRepository(WfInstanceRow).findOneByOrFail({ id: created.id }),
    )
    expect(inst.state).toBe('running')
  } finally {
    await ds.query('UPDATE iam_user SET enabled = ? WHERE id = ? AND tenant_id = ?', [
      reviewer.enabled,
      first.users.alice,
      first.id,
    ])
  }
})
