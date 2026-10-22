import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import {
  compile,
  fieldsFromFormSchema,
  storageObjectPerms,
  STORAGE_MAX_SIZE_DEFAULT,
  fsObjectQuery,
  type WfBeginNode,
  type WfFields,
} from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { cleanRedis } from '../setup/redis.js'
import { PermVersion } from '../../src/core/auth/perm-version.js'
import { withTenant } from '../../src/core/context/tenant.js'
import { findRow, insertRow } from '../../src/db/seeds/upsert.js'
import { genericSchema } from '../../src/db/seeds/project/oa-generic.seed.js'
import { LEAVE_FIELDS } from '../../src/modules/biz/leave/leave-wf.handler.js'
import { OaExpenseClaim } from '../../src/modules/oa/expense/expense.entity.js'
import { EXPENSE_FIELDS } from '../../src/modules/oa/expense/expense-wf.handler.js'
import { SEAL_FIELDS } from '../../src/modules/oa/seal/seal-wf.handler.js'
import { TRIP_FIELDS } from '../../src/modules/oa/trip/trip-wf.handler.js'
import { OaAttachmentService } from '../../src/modules/oa/attachment/oa-attachment.service.js'
import { S3Storage } from '../../src/modules/platform/storage/s3-storage.js'
import { LocalStorage } from '../../src/modules/platform/storage/local-storage.js'
import { StorageAccess } from '../../src/modules/platform/storage/storage-access.js'
import { StorageService } from '../../src/modules/platform/storage/storage.service.js'
import type { StorageConfig } from '../../src/modules/platform/storage/config/config.entity.js'
import { FsObject } from '../../src/modules/platform/storage/fs-object.entity.js'
import { WfTaskRow } from '../../src/modules/workflow/runtime/wf-runtime.entity.js'
import { bearer, signIn } from '../setup/auth.js'
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
const STORAGE = '/api/storage/objects'
const routes = {
  leave: '/api/biz/leaves',
  trip: '/api/oa/trips',
  expense: '/api/oa/expense-claims',
  seal: '/api/oa/seal-requests',
}
type Kind = keyof typeof routes
const http = (
  who: string,
  method: 'get' | 'post' | 'put' | 'delete',
  path: string,
  body?: object,
) => {
  const req = request(app.getHttpServer())[method](path).set(bearer(tokens[who]!))
  return body === undefined ? req : req.send(body)
}
const wf = (who: string, path: string, body = {}) => http(who, 'post', '/api/wf/' + path, body)
const tree = (hidden = false): WfBeginNode => ({
  id: 'begin',
  type: 'begin',
  name: 'Begin',
  access: { attachments: 'edit' },
  next: {
    id: 'review',
    type: 'review',
    name: 'Review',
    assignee: { kind: 'initiatorPicks' },
    sign: 'any',
    whenNobody: 'toManager',
    whenInitiatorIsReviewer: 'self',
    onReject: 'finish',
    ...(hidden ? { access: { attachments: 'hide' as const } } : {}),
  },
})
const fields: Record<Kind, WfFields> = {
  leave: LEAVE_FIELDS,
  trip: TRIP_FIELDS,
  expense: EXPENSE_FIELDS,
  seal: SEAL_FIELDS,
}
async function publish(
  tenant: PeopledTenant,
  key: string,
  formFields: WfFields,
  flow = tree(),
  dynamic = false,
) {
  await withTenant(tenant.id, () =>
    ds.transaction(async (q) => {
      const model = await findRow(q, 'wf_model', { model_key: key })
      if (!model) throw new Error('Missing fixture model')
      const flowResult = compile(flow, formFields)
      if (!flowResult.ok) throw new Error('Invalid fixture tree')
      const [{ version }] = await q.query<{ version: number }[]>(
        'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM wf_version WHERE model_key = ? AND tenant_id = ?',
        [key, tenant.id],
      )
      const id = await insertRow(q, 'wf_version', {
        model_id: model.id,
        model_key: key,
        version,
        tree_json: flowResult.flow.root,
        form_snapshot: { fields: formFields, ...(dynamic ? { schema: genericSchema } : {}) },
      })
      await q.query(
        'UPDATE wf_model SET enabled = 1, current_version_id = ? WHERE id = ? AND tenant_id = ?',
        [id, model.id, tenant.id],
      )
    }),
  )
}
function payload(kind: Kind, ids: number[], extra: object = {}) {
  const reason = `Office attachment ${++seq}`
  return {
    ...{
      leave: {
        leaveKind: 'annual',
        startAt: '2026-11-01T00:00:00Z',
        endAt: '2026-11-02T00:00:00Z',
        days: 1,
        reason,
      },
      trip: {
        destination: 'North office',
        startAt: '2026-11-01T00:00:00Z',
        endAt: '2026-11-02T00:00:00Z',
        reason,
      },
      expense: {
        reason,
        items: [
          { expenseDate: '2026-11-01', expenseKind: 'travel', amount: '1.00', description: reason },
        ],
      },
      seal: {
        sealKind: 'company',
        documentName: reason,
        purpose: reason,
        copies: 1,
        expectedDate: '2026-11-03',
      },
    }[kind],
    attachmentIds: ids,
    initiatorPicks: { review: [first.users.alice] },
    ...extra,
  }
}
const submit = async (kind: Kind, ids: number[], extra = {}) =>
  (await http('owner', 'post', routes[kind], payload(kind, ids, extra)).expect(201)).body.data
async function upload(who = 'owner', tag = 'oa.attachment') {
  const name = `document-${++seq}.txt`
  return (
    await request(app.getHttpServer())
      .post(STORAGE)
      .set(bearer(tokens[who]!))
      .field('bizTag', tag)
      .attach('file', Buffer.from('Office attachment'), name)
      .expect(201)
  ).body.data
}
const stored = (id: number, tenant = first) =>
  withTenant(tenant.id, () =>
    ds.getRepository(FsObject).findOne({ where: { id }, withDeleted: true }),
  )
const pending = (instanceId: number, nodeId = 'review') =>
  withTenant(first.id, () =>
    ds.getRepository(WfTaskRow).findOneByOrFail({ instanceId, nodeId, state: 'pending' }),
  )
const read = (who: string, id: number, tail = '/metadata') =>
  http(who, 'get', `${STORAGE}/${id}${tail}`)

beforeAll(async () => {
  app = await bootApp({ multiTenant: true })
  ds = app.get<DataSource>(getDataSourceToken())
  await cleanRedis(app.get<Redis>(REDIS))
  first = await createTenant(app, { users: true })
  second = await createTenant(app, { users: true })
  await ds.query('UPDATE iam_user SET password_changed_at = NOW(3) WHERE tenant_id IN (?, ?)', [
    first.id,
    second.id,
  ])
  // 文件管理权限本身不能使同租户的非参与者获得业务附件。
  const menus = await ds.query<{ id: number }[]>(
    'SELECT id FROM iam_menu WHERE perms IN (?) AND deleted_at IS NULL',
    [Object.values(storageObjectPerms)],
  )
  await ds.query('INSERT IGNORE INTO iam_role_menus (role_id, menu_id, tenant_id) VALUES ?', [
    menus.map((menu) => [first.roleId, menu.id, first.id]),
  ])
  for (const [who, id] of Object.entries({
    owner: first.ownerId,
    reviewer: first.users.alice,
    outsider: first.users.admin,
    foreign: second.ownerId,
  })) {
    const signed = await signInDirect(app, id)
    if (!signed) throw new Error('Fixture sign-in failed')
    tokens[who] = signed.accessToken
  }
  tokens.root = (await signIn(app)).accessToken
  for (const tenant of [first, second])
    for (const kind of Object.keys(routes) as Kind[])
      await publish(tenant, kind === 'leave' ? 'leave' : `oa-${kind}`, fields[kind])
  const dynamicFields = fieldsFromFormSchema(genericSchema)
  if (!dynamicFields.ok) throw new Error('Invalid dynamic fields')
  await publish(first, 'oa-generic', dynamicFields.fields, tree(true), true)
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  if (ds && first && second) {
    const files = await ds.query<{ object_key: string }[]>(
      'SELECT object_key FROM fs_object WHERE tenant_id IN (?, ?)',
      [first.id, second.id],
    )
    for (const file of files) {
      await new LocalStorage().remove(file.object_key, false)
      await new LocalStorage().remove(file.object_key, true)
    }
  }
  await second?.dispose()
  await first?.dispose()
  await app?.close()
})

describe('private office attachment access', () => {
  it.each(Object.keys(routes) as Kind[])(
    '%s binds real uploads atomically and authorizes participants on every read entrance',
    async (kind) => {
      const file = await upload()
      await read('owner', file.id).expect(200)
      await read('reviewer', file.id).expect(403)
      const doc = await submit(kind, [file.id])
      expect((await stored(file.id))?.bizRef).toBe(`oa:${kind}:${doc.id}`)
      for (const who of ['owner', 'reviewer']) {
        const metadata = (await read(who, file.id).expect(200)).body.data
        expect(metadata).toMatchObject({
          id: file.id,
          originalName: file.originalName,
          isPublic: false,
          url: null,
        })
        expect(metadata).not.toHaveProperty('objectKey')
        expect(metadata).not.toHaveProperty('bizRef')
        expect(metadata).not.toHaveProperty('sha256')
        await read(who, file.id, '/download').expect(200)
        await read(who, file.id, '/download?inline=true').expect(200)
        await read(who, file.id, '').expect(200)
      }
      for (const tail of [
        '/metadata',
        '/download',
        '/download?inline=true',
        '/content',
        '/content?inline=true',
        '',
      ]) {
        await read('outsider', file.id, tail).expect(403)
        await read('foreign', file.id, tail).expect(404)
        await read('root', file.id, tail).expect(404)
      }
      await http('owner', 'delete', `${STORAGE}/${file.id}`).expect(403)
      await http('foreign', 'delete', `${STORAGE}/${file.id}`).expect(404)
      expect((await stored(file.id))?.deletedAt).toBeNull()
      const listing = (await http('owner', 'get', STORAGE).expect(200)).body.data
      expect(listing.items.some((item: { id: number }) => item.id === file.id)).toBe(false)
      expect(
        (await http('owner', 'get', STORAGE + '?bizTag=oa.attachment').expect(200)).body.data.items,
      ).toEqual([])
      const exportResponse = await http(
        'owner',
        'get',
        STORAGE + '/export?bizTag=oa.attachment',
      ).expect(200)
      expect(exportResponse.headers['content-type']).toContain('spreadsheet')
      // 同一个文件不能被另一张业务单重新绑定，即使还是上传者本人。
      await http('owner', 'post', routes[kind], payload(kind, [file.id])).expect(400)
      expect((await stored(file.id))?.bizRef).toBe(`oa:${kind}:${doc.id}`)
    },
  )

  it.each(Object.keys(routes) as Kind[])(
    '%s replaces attachments only after return, preserves kept refs and soft-deletes removed refs',
    async (kind) => {
      const old = await upload()
      const kept = await upload()
      const fresh = await upload()
      const doc = await submit(kind, [old.id, kept.id])
      await http('owner', 'put', `${routes[kind]}/${doc.id}`, { attachmentIds: [fresh.id] }).expect(
        409,
      )
      const task = await pending(doc.instanceId)
      await wf('reviewer', `tasks/${task.id}/send-back`, { to: 'begin' }).expect(200)
      await http('owner', 'put', `${routes[kind]}/${doc.id}`, {
        attachmentIds: [kept.id, fresh.id],
      }).expect(200)
      expect((await stored(old.id))?.deletedAt).not.toBeNull()
      expect((await stored(kept.id))?.deletedAt).toBeNull()
      expect((await stored(fresh.id))?.bizRef).toBe(`oa:${kind}:${doc.id}`)
      await read('owner', old.id).expect(404)
      await http('owner', 'put', `${routes[kind]}/${doc.id}`, { attachmentIds: [old.id] }).expect(
        400,
      )
      const begin = await pending(doc.instanceId, 'begin')
      await wf('owner', `tasks/${begin.id}/resubmit`).expect(200)
      await read('reviewer', fresh.id).expect(200)
    },
  )

  it('refuses other owners, other tenants, other tags, deleted files, invalid size/type and forged upload options', async () => {
    const invalid: number[] = []
    let rejectedTypeId = 0
    invalid.push(
      (await upload('outsider')).id,
      (await upload('foreign')).id,
      (await upload('owner', 'attachment')).id,
    )
    const deleted = await upload()
    await http('owner', 'delete', `${STORAGE}/${deleted.id}`).expect(200)
    invalid.push(deleted.id)
    for (const values of [
      { size: 0 },
      { size: 2147483649 },
      { mime: '' },
      { originalName: 'virus.exe' },
      { isPublic: true },
    ]) {
      const file = await upload()
      await withTenant(first.id, () => ds.getRepository(FsObject).update(file.id, values))
      invalid.push(file.id)
      if (values.originalName) rejectedTypeId = file.id
    }
    for (const id of [...invalid, 999999999])
      await http('owner', 'post', routes.trip, payload('trip', [id])).expect(
        id === rejectedTypeId ? 422 : 400,
      )
    await http('owner', 'post', routes.trip, payload('trip', [1, 1])).expect(400)
    await http('owner', 'post', routes.trip, payload('trip', [-1])).expect(400)
    await read('owner', 999999999).expect(404)
    await http('owner', 'get', `${STORAGE}/bad/metadata`).expect(400)
    await request(app.getHttpServer()).get(`${STORAGE}/${invalid[0]}/metadata`).expect(401)
    // 客户端不能选择公开或指定单据归属，上传契约只采信业务标签。
    const forged = await request(app.getHttpServer())
      .post(STORAGE)
      .set(bearer(tokens.owner!))
      .field('bizTag', 'oa.attachment')
      .field('isPublic', 'true')
      .field('bizRef', 'oa:trip:1')
      .attach('file', Buffer.from('private'), `forged-${++seq}.txt`)
      .expect(201)
    expect(forged.body.data.isPublic).toBe(false)
    expect((await stored(forged.body.data.id))?.bizRef).toBeNull()
  })

  it('rolls back all bindings and removals when starting or updating fails', async () => {
    const valid = await upload()
    const invalid = await upload('outsider')
    const before = await withTenant(first.id, () => ds.getRepository(OaExpenseClaim).count())
    await http(
      'owner',
      'post',
      routes.expense,
      payload('expense', [valid.id], {
        items: [
          {
            expenseDate: '2026-11-01',
            expenseKind: 'travel',
            amount: '1',
            description: 'Bad owner',
            attachmentIds: [invalid.id],
          },
        ],
      }),
    ).expect(400)
    expect(await withTenant(first.id, () => ds.getRepository(OaExpenseClaim).count())).toBe(before)
    expect((await stored(valid.id))?.bizRef).toBeNull()
    await http(
      'owner',
      'post',
      routes.trip,
      payload('trip', [valid.id], { initiatorPicks: {} }),
    ).expect(400)
    expect((await stored(valid.id))?.bizRef).toBeNull()
    const doc = await submit('trip', [valid.id])
    await wf('reviewer', `tasks/${(await pending(doc.instanceId)).id}/send-back`, {
      to: 'begin',
    }).expect(200)
    await http('owner', 'put', `${routes.trip}/${doc.id}`, { attachmentIds: [invalid.id] }).expect(
      400,
    )
    expect((await stored(valid.id))?.deletedAt).toBeNull()
    expect(
      (await http('owner', 'get', `${routes.trip}/${doc.id}`).expect(200)).body.data.attachmentIds,
    ).toEqual([valid.id])
  })

  it('deduplicates expense header and active lines, caps the whole claim and removes only unused files', async () => {
    const shared = await upload()
    const lineOnly = await upload()
    const fresh = await upload()
    const item = (ids: number[]) => ({
      expenseDate: '2026-11-01',
      expenseKind: 'travel',
      amount: '0.10',
      description: 'Receipt',
      attachmentIds: ids,
    })
    const doc = await submit('expense', [shared.id], { items: [item([shared.id, lineOnly.id])] })
    await wf('reviewer', `tasks/${(await pending(doc.instanceId)).id}/send-back`, {
      to: 'begin',
    }).expect(200)
    await http('owner', 'put', `${routes.expense}/${doc.id}`, {
      attachmentIds: [],
      items: [{ ...item([shared.id, fresh.id]), id: doc.items[0].id }],
    }).expect(200)
    expect((await stored(shared.id))?.deletedAt).toBeNull()
    expect((await stored(lineOnly.id))?.deletedAt).not.toBeNull()
    await http('owner', 'put', `${routes.expense}/${doc.id}`, {
      reason: 'Keep unchanged receipts',
    }).expect(200)
    await read('reviewer', shared.id).expect(200)
    const many = []
    for (let i = 0; i < 11; i++) many.push((await upload()).id)
    await http(
      'owner',
      'post',
      routes.expense,
      payload('expense', many.slice(0, 6), { items: [item(many.slice(6))] }),
    ).expect(400)
    for (const id of many) expect((await stored(id))?.bizRef).toBeNull()
    const max = await submit('expense', many.slice(0, 5), { items: [item(many.slice(5, 10))] })
    expect(max.items[0].attachmentIds).toHaveLength(5)
    await http('owner', 'post', routes.trip, payload('trip', many)).expect(400)
  })

  it('requires an active business reference, even for the uploader or file administrator', async () => {
    const file = await upload()
    const doc = await submit('expense', [], {
      items: [
        {
          expenseDate: '2026-11-01',
          expenseKind: 'travel',
          amount: '1',
          description: 'Active line',
          attachmentIds: [file.id],
        },
      ],
    })
    await ds.query(
      'UPDATE oa_expense_item SET deleted_at = NOW(3) WHERE claim_id = ? AND tenant_id = ?',
      [doc.id, first.id],
    )
    for (const who of ['owner', 'reviewer', 'outsider']) await read(who, file.id).expect(403)
  })

  it('generic attachments enforce hidden fields for uploader and global viewers across all entrances', async () => {
    const file = await upload('owner', 'wf.attachment')
    const started = await wf('owner', 'instances', {
      modelKey: 'oa-generic',
      initiatorPicks: { review: [first.users.alice] },
      formValues: {
        title: 'Hidden receipt',
        description: 'Private',
        expectedDate: '2026-11-03',
        attachments: `${file.id}/${file.originalName}`,
      },
    }).expect(201)
    for (const tail of [
      '/metadata',
      '/download',
      '/download?inline=true',
      '/content',
      '/content?inline=true',
      '',
    ]) {
      await read('owner', file.id, tail).expect(200)
      await read('reviewer', file.id, tail).expect(403)
      await read('outsider', file.id, tail).expect(403)
      await read('foreign', file.id, tail).expect(404)
    }
    await http('owner', 'delete', `${STORAGE}/${file.id}`).expect(403)
    expect(
      (await http('owner', 'get', STORAGE + '?bizTag=wf.attachment').expect(200)).body.data.items,
    ).toEqual([])
    await ds.query('UPDATE wf_instance SET form_values = ? WHERE id = ? AND tenant_id = ?', [
      JSON.stringify({
        title: 'Removed',
        description: 'Private',
        expectedDate: '2026-11-03',
        attachments: '',
      }),
      started.body.data.id,
      first.id,
    ])
    await read('owner', file.id).expect(403)
    await read('owner', file.id, '/download').expect(403)
  })

  it('removing workflow from a tenant package closes storage access for already-bound office and generic files', async () => {
    const office = await upload()
    await submit('trip', [office.id])
    const generic = await upload('owner', 'wf.attachment')
    await wf('owner', 'instances', {
      modelKey: 'oa-generic',
      initiatorPicks: { review: [first.users.alice] },
      formValues: {
        title: 'Feature receipt',
        description: 'Private',
        expectedDate: '2026-11-03',
        attachments: `${generic.id}/${generic.originalName}`,
      },
    }).expect(201)
    const menus = await ds.query<{ id: number }[]>(
      'SELECT id FROM iam_menu WHERE deleted_at IS NULL AND (route_name = ? OR perms LIKE ? OR perms LIKE ?)',
      ['oa', 'oa.%', 'storage.%'],
    )
    const limited = await createPackage(app, { menuIds: menus.map((m) => m.id) })
    try {
      await ds.query('UPDATE iam_tenant SET package_id = ? WHERE id = ?', [limited.id, first.id])
      await app.get(PermVersion).bumpUsers([first.ownerId, first.users.alice])
      for (const id of [office.id, generic.id])
        for (const tail of ['/metadata', '/download', '/content', ''])
          await read('owner', id, tail).expect(403)
    } finally {
      await ds.query('UPDATE iam_tenant SET package_id = ? WHERE id = ?', [
        first.packageId,
        first.id,
      ])
      await app.get(PermVersion).bumpUsers([first.ownerId, first.users.alice])
      await limited.dispose()
    }
    await read('owner', office.id).expect(200)
  })
  it('concurrent claims cannot bind the same previously unbound upload twice', async () => {
    const file = await upload()
    const results = await Promise.all([
      http('owner', 'post', routes.trip, payload('trip', [file.id])),
      http('owner', 'post', routes.trip, payload('trip', [file.id])),
    ])
    expect(results.map((res) => res.status).sort()).toEqual([201, 400])
    const winner = results.find((res) => res.status === 201)!.body.data
    expect((await stored(file.id))?.bizRef).toBe(`oa:trip:${winner.id}`)
  })

  it('a failure after removing and binding files rolls the complete edit back', async () => {
    const old = await upload()
    const fresh = await upload()
    const doc = await submit('trip', [old.id])
    await wf('reviewer', `tasks/${(await pending(doc.instanceId)).id}/send-back`, {
      to: 'begin',
    }).expect(200)
    const service = app.get(OaAttachmentService)
    const original = service.sync.bind(service)
    const fail = vi.spyOn(service, 'sync').mockImplementationOnce(async (...args) => {
      await original(...args)
      throw new Error('Business transaction failed after attachment replacement')
    })
    await http('owner', 'put', `${routes.trip}/${doc.id}`, { attachmentIds: [fresh.id] }).expect(
      500,
    )
    fail.mockRestore()
    expect((await stored(old.id))?.deletedAt).toBeNull()
    expect((await stored(fresh.id))?.bizRef).toBeNull()
    expect(
      (await http('owner', 'get', `${routes.trip}/${doc.id}`).expect(200)).body.data.attachmentIds,
    ).toEqual([old.id])
  })

  it('direct-upload confirmation keeps office files private, grants only its owner, and binds the confirmed file', async () => {
    // 仅替换 S3 适配器边界：令牌、大小与字节嗅探、对象登记及业务绑定都走真实接口。
    const bytes = Buffer.from('Office direct upload')
    const fake = Object.create(S3Storage.prototype) as S3Storage
    vi.spyOn(fake, 'presignPut').mockResolvedValue({
      url: 'https://storage.example.test/staged',
      headers: { 'Content-Type': 'text/plain' },
    })
    vi.spyOn(fake, 'headStaged').mockResolvedValue({
      size: bytes.length,
      etag: 'local-etag',
      sha256: null,
    })
    vi.spyOn(fake, 'readStaged').mockResolvedValue(bytes)
    vi.spyOn(fake, 'publish').mockImplementation(async (key, _etag, isPublic, mime) => {
      await new LocalStorage().put(key, bytes, isPublic, mime)
      return true
    })
    vi.spyOn(fake, 'dropStaged').mockResolvedValue(undefined)
    const storage = app.get(StorageService) as unknown as {
      clientFor: (config: StorageConfig) => S3Storage
    }
    const client = vi.spyOn(storage, 'clientFor').mockReturnValue(fake)
    const grant = (
      await http('owner', 'post', STORAGE + '/presign', {
        filename: `direct-${++seq}.txt`,
        size: bytes.length,
        mime: 'text/plain',
        bizTag: 'oa.attachment',
      }).expect(200)
    ).body.data
    await http('outsider', 'post', STORAGE + '/confirm', { key: grant.key }).expect(404)
    await http('foreign', 'post', STORAGE + '/confirm', { key: grant.key }).expect(404)
    const confirmed = (
      await http('owner', 'post', STORAGE + '/confirm', { key: grant.key }).expect(201)
    ).body.data
    await http('owner', 'post', STORAGE + '/confirm', { key: grant.key }).expect(404)
    expect(confirmed).toMatchObject({ isPublic: false, url: null, bizTag: 'oa.attachment' })
    client.mockRestore()
    await read('owner', confirmed.id, '/download').expect(200)
    const doc = await submit('seal', [confirmed.id])
    expect((await stored(confirmed.id))?.bizRef).toBe(`oa:seal:${doc.id}`)
    await read('reviewer', confirmed.id).expect(200)
    await read('foreign', confirmed.id).expect(404)
  })
})

it('refuses protected files when their business checker is unavailable', async () => {
  const office = await upload()
  await submit('trip', [office.id])
  const generic = await upload('owner', 'wf.attachment')
  await wf('owner', 'instances', {
    modelKey: 'oa-generic',
    initiatorPicks: { review: [first.users.alice] },
    formValues: {
      title: 'Private matter',
      description: 'Checker unavailable',
      expectedDate: '2026-11-03',
      attachments: `${generic.id}/${generic.originalName}`,
    },
  }).expect(201)
  const registry = (app.get(StorageAccess) as unknown as { checkers: Map<string, unknown> })
    .checkers
  const saved = ['oa.attachment', 'wf.attachment'].map((tag) => [tag, registry.get(tag)] as const)
  try {
    for (const [tag] of saved) registry.delete(tag)
    for (const file of [office, generic])
      for (const who of ['owner', 'outsider'])
        for (const tail of ['/metadata', '/download', '/content', ''])
          await read(who, file.id, tail).expect(403)
    for (const [tag] of saved) {
      const listing = (await http('owner', 'get', STORAGE + '?bizTag=' + tag).expect(200)).body.data
      expect(listing.items).toEqual([])
      const exported = await withTenant(first.id, async () => {
        const rows: object[] = []
        for await (const batch of app
          .get(StorageService)
          .exportRows(fsObjectQuery.parse({ bizTag: tag })))
          rows.push(...batch)
        return rows
      })
      expect(exported).toEqual([])
    }
  } finally {
    for (const [tag, checker] of saved) registry.set(tag, checker)
  }
  await read('owner', office.id).expect(200)
  await read('owner', generic.id).expect(200)
})

it('cannot introduce a lingering same-document binding absent from its previous attachment IDs', async () => {
  const file = await upload()
  const doc = await submit('trip', [])
  await wf('reviewer', `tasks/${(await pending(doc.instanceId)).id}/send-back`, {
    to: 'begin',
  }).expect(200)
  await withTenant(first.id, () =>
    ds.getRepository(FsObject).update(file.id, { bizRef: `oa:trip:${doc.id}` }),
  )
  await read('owner', file.id).expect(403)
  await http('owner', 'put', `${routes.trip}/${doc.id}`, { attachmentIds: [file.id] }).expect(400)
  expect(
    (await http('owner', 'get', `${routes.trip}/${doc.id}`).expect(200)).body.data.attachmentIds,
  ).toEqual([])
  expect((await stored(file.id))?.bizRef).toBe(`oa:trip:${doc.id}`)
  expect((await stored(file.id))?.deletedAt).toBeNull()
})

it('serves fixed-origin S3 content without redirects and rejects oversized or changed bodies', async () => {
  const file = await upload()
  await submit('trip', [file.id])
  const object = await stored(file.id)
  if (!object) throw new Error('File fixture missing')
  const client = Object.create(S3Storage.prototype) as S3Storage
  const bytes = Buffer.from('Office attachment')
  const readS3 = vi.spyOn(client, 'read').mockResolvedValue(bytes)
  const redirect = vi.spyOn(client, 'presignGet').mockRejectedValue(new Error('Must not redirect'))
  const storage = app.get(StorageService)
  vi.spyOn(
    storage as unknown as { clientFor(config: StorageConfig): S3Storage },
    'clientFor',
  ).mockReturnValue(client)
  const response = await read(
    'owner',
    file.id,
    '/content?url=https%3A%2F%2Fexample.invalid',
  ).expect(200)
  expect(response.headers.location).toBeUndefined()
  expect(response.headers['x-content-type-options']).toBe('nosniff')
  expect(response.headers['content-security-policy']).toContain('sandbox')
  expect(response.text).toBe(bytes.toString())
  expect(readS3).toHaveBeenCalledExactlyOnceWith(object.objectKey, false, object.size + 1)
  expect(redirect).not.toHaveBeenCalled()
  readS3.mockClear()
  await read('outsider', file.id, '/content').expect(403)
  await read('foreign', file.id, '/content').expect(404)
  expect(readS3).not.toHaveBeenCalled()
  await withTenant(first.id, () =>
    ds.getRepository(FsObject).update(file.id, { size: STORAGE_MAX_SIZE_DEFAULT + 1 }),
  )
  try {
    await read('owner', file.id, '/content').expect(413)
    expect(readS3).not.toHaveBeenCalled()
  } finally {
    await withTenant(first.id, () =>
      ds.getRepository(FsObject).update(file.id, { size: object.size }),
    )
  }
  readS3.mockResolvedValueOnce(null)
  await read('owner', file.id, '/content').expect(404)
  readS3.mockResolvedValueOnce(Buffer.from('changed'))
  await read('owner', file.id, '/content').expect(404)
  expect(redirect).not.toHaveBeenCalled()
})
