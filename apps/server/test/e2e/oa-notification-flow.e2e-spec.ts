import type { MockInstance } from 'vitest'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import { compile, type WfBeginNode, type WfFields } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { withTenant } from '../../src/core/context/tenant.js'
import { NotifyDispatcher } from '../../src/core/notify/notify.js'
import { findRow, insertRow } from '../../src/db/seeds/upsert.js'
import { LEAVE_FIELDS } from '../../src/modules/biz/leave/leave-wf.handler.js'
import { EXPENSE_FIELDS } from '../../src/modules/oa/expense/expense-wf.handler.js'
import { SEAL_FIELDS } from '../../src/modules/oa/seal/seal-wf.handler.js'
import { TRIP_FIELDS } from '../../src/modules/oa/trip/trip-wf.handler.js'
import { MailTransports } from '../../src/modules/platform/messaging/mail-account/mail-transports.js'
import { WfHandlers } from '../../src/modules/workflow/runtime/wf-handlers.js'
import { WfNotify } from '../../src/modules/workflow/runtime/wf-notify.js'
import { WfTaskRow } from '../../src/modules/workflow/runtime/wf-runtime.entity.js'
import { bearer } from '../setup/auth.js'
import {
  bootApp,
  createTenant,
  inTenant1,
  signInDirect,
  type PeopledTenant,
} from '../setup/tenants.js'

let app: NestExpressApplication
let ds: DataSource
let first: PeopledTenant
let second: PeopledTenant
let accountId: number
let seq = 0
let send: MockInstance<MailTransports['send']>
const tokens: Record<string, string> = {}
const routes = {
  leave: '/api/biz/leaves',
  trip: '/api/oa/trips',
  expense: '/api/oa/expense-claims',
  seal: '/api/oa/seal-requests',
}
type Kind = keyof typeof routes
const fields: Record<Kind, WfFields> = {
  leave: LEAVE_FIELDS,
  trip: TRIP_FIELDS,
  expense: EXPENSE_FIELDS,
  seal: SEAL_FIELDS,
}
const keyOf = (kind: Kind) => (kind === 'leave' ? 'leave' : `oa-${kind}`)
const http = (who: string, path: string, body = {}) =>
  request(app.getHttpServer()).post(path).set(bearer(tokens[who]!)).send(body)
const wf = (who: string, path: string, body = {}) => http(who, '/api/wf/' + path, body)
const dispatcher = () => app.get(NotifyDispatcher)
const pending = (instanceId: number, nodeId = 'review') =>
  withTenant(first.id, () =>
    ds.getRepository(WfTaskRow).findOneByOrFail({ instanceId, nodeId, state: 'pending' }),
  )
async function publish(tenant: PeopledTenant, kind: Kind) {
  const tree: WfBeginNode = {
    id: 'begin',
    type: 'begin',
    name: 'Begin',
    next: {
      id: 'review',
      type: 'review',
      name: 'Review',
      assignee: { kind: 'initiatorPicks' },
      sign: 'any',
      whenNobody: 'toManager',
      whenInitiatorIsReviewer: 'self',
      onReject: 'finish',
    },
  }
  await withTenant(tenant.id, () =>
    ds.transaction(async (q) => {
      const key = keyOf(kind)
      const model = await findRow(q, 'wf_model', { model_key: key })
      if (!model) throw new Error('Missing office model')
      const compiled = compile(tree, fields[kind])
      if (!compiled.ok) throw new Error('Invalid office fixture')
      const [{ version }] = await q.query<{ version: number }[]>(
        'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM wf_version WHERE model_key = ? AND tenant_id = ?',
        [key, tenant.id],
      )
      const id = await insertRow(q, 'wf_version', {
        model_id: model.id,
        model_key: key,
        version,
        tree_json: compiled.flow.root,
        form_snapshot: { fields: fields[kind] },
      })
      await q.query(
        'UPDATE wf_model SET enabled = 1, current_version_id = ? WHERE id = ? AND tenant_id = ?',
        [id, model.id, tenant.id],
      )
    }),
  )
}
function body(kind: Kind, extra = {}) {
  const reason = `Office message ${++seq}`
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
    initiatorPicks: { review: [first.users.alice] },
    ...extra,
  }
}
const submit = async (kind: Kind) =>
  (await http('owner', routes[kind], body(kind)).expect(201)).body.data
async function notices(instanceId: number, table = 'msg_inbox') {
  // 测试表名来自本文件常量；消息参数固定带实例 ID，避免把别的流程通知计入断言。
  const rows =
    table === 'msg_inbox'
      ? await ds.query<{ id: number; user_id: number; template_code: string; status: string }[]>(
          "SELECT id, user_id, template_code, status FROM msg_inbox WHERE tenant_id = ? AND params ->> '$.instanceId' = ? ORDER BY id",
          [first.id, String(instanceId)],
        )
      : await ds.query<{ id: number; user_id: number; template_code: string; status: string }[]>(
          "SELECT id, user_id, template_code, status FROM msg_mail_record WHERE tenant_id = ? AND params ->> '$.instanceId' = ? ORDER BY id",
          [first.id, String(instanceId)],
        )
  return rows
}
async function counts() {
  const [row] = await ds.query<
    { instances: number; events: number; inbox: number; mail: number }[]
  >(
    'SELECT (SELECT COUNT(*) FROM wf_instance WHERE tenant_id = ?) AS instances, (SELECT COUNT(*) FROM wf_event WHERE tenant_id = ?) AS events, (SELECT COUNT(*) FROM msg_inbox WHERE tenant_id = ?) AS inbox, (SELECT COUNT(*) FROM msg_mail_record WHERE tenant_id = ?) AS mail',
    [first.id, first.id, first.id, first.id],
  )
  return row
}

beforeAll(async () => {
  // 每个邮件调用都被替换；不创建 SMTP 连接，不向真实地址发送。
  send = vi.spyOn(MailTransports.prototype, 'send').mockImplementation(async () => ({
    messageId: `local-message-${++seq}`,
    envelope: { from: 'local@example.invalid', to: [] },
  }))
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
    observer: first.users.admin,
    foreign: second.ownerId,
  })) {
    await ds.query('UPDATE iam_user SET email = ? WHERE id = ? AND tenant_id = ?', [
      who === 'observer' ? null : `${who}@example.test`,
      id,
      who === 'foreign' ? second.id : first.id,
    ])
    const signed = await signInDirect(app, id)
    if (!signed) throw new Error('Fixture sign-in failed')
    tokens[who] = signed.accessToken
  }
  accountId = await inTenant1(() =>
    insertRow(ds.manager, 'msg_mail_account', {
      name: 'Office local mail fixture',
      address: 'office@example.test',
      host: 'invalid.example.test',
      port: 465,
      security: 'ssl',
      enabled: 1,
    }),
  )
  for (const kind of Object.keys(routes) as Kind[]) await publish(first, kind)
})
afterAll(async () => {
  await dispatcher()?.idle()
  await second?.dispose()
  await first?.dispose()
  if (accountId) await ds.query('DELETE FROM msg_mail_account WHERE id = ?', [accountId])
  await app?.close()
  vi.restoreAllMocks()
})

describe('office notifications through existing transactional outbox', () => {
  it.each(Object.keys(routes) as Kind[])(
    '%s delivers assigned, cc, urged and approved notices once after successful business commit',
    async (kind) => {
      const doc = await submit(kind)
      await dispatcher().idle()
      expect(await notices(doc.instanceId)).toEqual([
        expect.objectContaining({
          user_id: first.users.alice,
          template_code: 'wf.task.assigned',
          status: 'delivered',
        }),
      ])
      expect(await notices(doc.instanceId, 'mail')).toEqual([
        expect.objectContaining({
          user_id: first.users.alice,
          template_code: 'wf.task.assigned',
          status: 'sent',
        }),
      ])
      const task = await pending(doc.instanceId)
      await wf('reviewer', `tasks/${task.id}/cc`, { userIds: [first.users.admin] }).expect(200)
      await wf('owner', `instances/${doc.instanceId}/urge`).expect(200)
      await wf('owner', `instances/${doc.instanceId}/urge`).expect(429)
      await wf('reviewer', `tasks/${task.id}/approve`).expect(200)
      await dispatcher().idle()
      const saved = (
        await request(app.getHttpServer())
          .get(`${routes[kind]}/${doc.id}`)
          .set(bearer(tokens.owner!))
          .expect(200)
      ).body.data
      expect(saved.state).toBe('approved')
      const inbox = await notices(doc.instanceId)
      expect(inbox.map((row) => row.template_code)).toEqual([
        'wf.task.assigned',
        'wf.cc',
        'wf.task.urged',
        'wf.instance.approved',
      ])
      const mail = await notices(doc.instanceId, 'mail')
      expect(mail.find((row) => row.template_code === 'wf.cc')).toMatchObject({
        user_id: first.users.admin,
        status: 'skipped',
      })
      expect(
        mail.filter((row) => row.template_code !== 'wf.cc').every((row) => row.status === 'sent'),
      ).toBe(true)
      const before = await counts()
      await wf('reviewer', `tasks/${task.id}/approve`).expect(409)
      await wf('foreign', `tasks/${task.id}/approve`).expect(404)
      await dispatcher().idle()
      expect(await counts()).toEqual(before)
    },
  )

  it.each(Object.keys(routes) as Kind[])(
    '%s sends rejection and return notices, and a resubmit gets one new assignment',
    async (kind) => {
      const rejected = await submit(kind)
      await wf('reviewer', `tasks/${(await pending(rejected.instanceId)).id}/reject`, {
        comment: 'Declined',
      }).expect(200)
      const returned = await submit(kind)
      await wf('reviewer', `tasks/${(await pending(returned.instanceId)).id}/send-back`, {
        to: 'begin',
      }).expect(200)
      const begin = await pending(returned.instanceId, 'begin')
      await wf('owner', `tasks/${begin.id}/resubmit`).expect(200)
      await wf('owner', `tasks/${begin.id}/resubmit`).expect(409)
      await dispatcher().idle()
      expect((await notices(rejected.instanceId)).map((row) => row.template_code)).toEqual([
        'wf.task.assigned',
        'wf.instance.rejected',
      ])
      expect((await notices(returned.instanceId)).map((row) => row.template_code)).toEqual([
        'wf.task.assigned',
        'wf.instance.sent_back',
        'wf.task.assigned',
      ])
      expect(
        (await notices(returned.instanceId, 'mail')).every((row) => row.status === 'sent'),
      ).toBe(true)
    },
  )

  it.each(Object.keys(routes) as Kind[])(
    '%s rolls back the business action and sends nothing on synchronous writeback failure',
    async (kind) => {
      const handler = app.get(WfHandlers).get(keyOf(kind))!
      const beforeStart = await counts()
      const failedStart = vi
        .spyOn(handler, 'onStateChange')
        .mockRejectedValueOnce(new Error('Business write failed'))
      await http('owner', routes[kind], body(kind)).expect(500)
      failedStart.mockRestore()
      await dispatcher().idle()
      expect(await counts()).toEqual(beforeStart)
      const doc = await submit(kind)
      await dispatcher().idle()
      const task = await pending(doc.instanceId)
      const before = await counts()
      const deliveries = send.mock.calls.length
      const fail = vi
        .spyOn(handler, 'onStateChange')
        .mockRejectedValueOnce(new Error('Business write failed'))
      await wf('reviewer', `tasks/${task.id}/approve`).expect(500)
      fail.mockRestore()
      await dispatcher().idle()
      expect(await counts()).toEqual(before)
      expect(send.mock.calls.length).toBe(deliveries)
      expect((await pending(doc.instanceId)).id).toBe(task.id)
      await wf('reviewer', `tasks/${task.id}/approve`).expect(200)
      await dispatcher().idle()
      expect(
        (await notices(doc.instanceId)).filter(
          (row) => row.template_code === 'wf.instance.approved',
        ),
      ).toHaveLength(1)
    },
  )

  it('rolls back notifications already written inside the transaction before an outer failure', async () => {
    const notify = app.get(WfNotify)
    const original = notify.changed.bind(notify)
    const before = await counts()
    const deliveries = send.mock.calls.length
    const fail = vi.spyOn(notify, 'changed').mockImplementationOnce(async (...args) => {
      await original(...args)
      throw new Error('Outer save failed')
    })
    await http('owner', routes.trip, body('trip')).expect(500)
    fail.mockRestore()
    await dispatcher().idle()
    expect(await counts()).toEqual(before)
    expect(send.mock.calls.length).toBe(deliveries)
  })

  it('retries an existing failed mail record without replaying the approval or producing duplicate business events', async () => {
    const doc = await submit('expense')
    await dispatcher().idle()
    const task = await pending(doc.instanceId)
    send.mockRejectedValueOnce(new Error('Local delivery failure'))
    await wf('reviewer', `tasks/${task.id}/approve`).expect(200)
    await dispatcher().idle()
    const record = (await notices(doc.instanceId, 'mail')).find(
      (row) => row.template_code === 'wf.instance.approved',
    )!
    expect(record.status).toBe('failed')
    const before = await counts()
    const deliveries = send.mock.calls.length
    await withTenant(first.id, () => dispatcher().flush({ mail: [record.id] }))
    await withTenant(first.id, () => dispatcher().flush({ mail: [record.id] }))
    expect(send.mock.calls.length).toBe(deliveries + 1)
    expect(
      (await notices(doc.instanceId, 'mail')).find((row) => row.id === record.id)?.status,
    ).toBe('sent')
    expect(await counts()).toEqual(before)
    const [saved] = await ds.query<{ attempts: number }[]>(
      'SELECT attempts FROM msg_mail_record WHERE id = ? AND tenant_id = ?',
      [record.id, first.id],
    )
    expect(saved.attempts).toBe(2)
  })
})
