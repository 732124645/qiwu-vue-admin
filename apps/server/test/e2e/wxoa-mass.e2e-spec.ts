import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { Err, wxoaPerms } from '@qiwu/shared'
import { BizError } from '../../src/core/http/biz-error.js'
import { upstreamError } from '../../src/modules/platform/wxoa/core/wxoa-gateway.js'
import { WxoaInboundHub } from '../../src/modules/platform/wxoa/core/wxoa-inbound-hub.js'
import { bearer } from '../setup/auth.js'
import {
  addAccount,
  addContentUser,
  closeContentApp,
  openContentApp,
} from './wxoa-content.helpers.js'

describe('wxoa mass jobs', () => {
  let ctx: Awaited<ReturnType<typeof openContentApp>>
  const ids: number[] = []
  const userIds: number[] = []
  const roleIds: number[] = []
  let account: { id: number }
  let foreignAccount: { id: number }
  let draftId: number
  let reader: string
  const openIds = ['mass-open-a', 'mass-open-b']
  const http = () => request(ctx.app.getHttpServer())
  const sendText = (content: string) =>
    http()
      .post('/api/wxoa/mass-jobs')
      .set(bearer(ctx.admin))
      .send({ accountId: account.id, targetKind: 'all', msgKind: 'text', payload: { content } })

  beforeAll(async () => {
    ctx = await openContentApp()
    account = await addAccount(ctx)
    foreignAccount = await addAccount(ctx)
    ids.push(account.id, foreignAccount.id)
    await ctx.ds.query(
      "INSERT INTO wxoa_tag (tenant_id, account_id, tag_id, name) VALUES (1, ?, 88, 'mass-tag')",
      [account.id],
    )
    await ctx.ds.query(
      "INSERT INTO wxoa_tag (tenant_id, account_id, tag_id, name) VALUES (1, ?, 89, 'mass-foreign-tag')",
      [foreignAccount.id],
    )
    for (const openId of openIds)
      await ctx.ds.query(
        'INSERT INTO wxoa_fan (tenant_id, account_id, open_id, subscribed) VALUES (1, ?, ?, 1)',
        [account.id, openId],
      )
    await ctx.ds.query(
      "INSERT INTO wxoa_material (tenant_id, account_id, media_kind, media_id, origin) VALUES (1, ?, 'image', 'mass-cover', 'local')",
      [account.id],
    )
    const draft = await http()
      .post('/api/wxoa/drafts')
      .set(bearer(ctx.admin))
      .send({
        accountId: account.id,
        articles: [
          {
            title: 'Mass draft',
            author: '',
            digest: '',
            content: '<p>mass</p>',
            thumbMediaId: 'mass-cover',
            needOpenComment: true,
            onlyFansCanComment: false,
          },
        ],
      })
      .expect(201)
    draftId = Number(draft.body.data.id)
    ctx.fake.on('/cgi-bin/draft/add', { media_id: 'mass-media' })
    await http().post(`/api/wxoa/drafts/${draftId}/sync`).set(bearer(ctx.admin)).expect(201)
    const user = await addContentUser(ctx, [wxoaPerms.mass.browse])
    reader = user.accessToken
    userIds.push(user.userId)
    roleIds.push(user.roleId)
    ctx.fake.reset()
  })

  afterAll(async () => closeContentApp(ctx, ids, userIds, roleIds))

  it('sends all three target kinds and all five message kinds in the official request format', async () => {
    const cases = [
      {
        targetKind: 'all' as const,
        msgKind: 'text' as const,
        payload: { content: 'mass all text', extra: 'dropped' },
        expected: {
          filter: { is_to_all: true },
          msgtype: 'text',
          text: { content: 'mass all text' },
        },
        path: '/cgi-bin/message/mass/sendall',
      },
      {
        targetKind: 'tag' as const,
        tagId: 88,
        msgKind: 'image' as const,
        payload: { media_id: 'img-1' },
        sendIgnoreReprint: true,
        expected: {
          filter: { is_to_all: false, tag_id: 88 },
          msgtype: 'image',
          images: { media_ids: ['img-1'] },
        },
        path: '/cgi-bin/message/mass/sendall',
      },
      {
        targetKind: 'openids' as const,
        openIds,
        msgKind: 'voice' as const,
        payload: { media_id: 'voice-1' },
        expected: { touser: openIds, msgtype: 'voice', voice: { media_id: 'voice-1' } },
        path: '/cgi-bin/message/mass/send',
      },
      {
        targetKind: 'openids' as const,
        openIds,
        msgKind: 'video' as const,
        payload: { media_id: 'video-1', title: 'video', description: 'desc' },
        expected: {
          touser: openIds,
          msgtype: 'mpvideo',
          mpvideo: { media_id: 'video-1', title: 'video', description: 'desc' },
        },
        path: '/cgi-bin/message/mass/send',
      },
      {
        targetKind: 'all' as const,
        msgKind: 'video' as const,
        payload: { media_id: 'video-2', title: 'only for openid sends' },
        expected: {
          filter: { is_to_all: true },
          msgtype: 'mpvideo',
          mpvideo: { media_id: 'video-2' },
        },
        path: '/cgi-bin/message/mass/sendall',
      },
      {
        targetKind: 'all' as const,
        msgKind: 'mpnews' as const,
        draftId,
        payload: {},
        expected: {
          filter: { is_to_all: true },
          msgtype: 'mpnews',
          mpnews: { media_id: 'mass-media' },
        },
        path: '/cgi-bin/message/mass/sendall',
      },
    ]
    for (const [index, body] of cases.entries()) {
      const { expected, path, ...dto } = body
      // 官方示例里 msg_id、msg_data_id 是数字
      ctx.fake.on(path, { errcode: 0, msg_id: 34182 + index, msg_data_id: 206227730 + index })
      const response = await http()
        .post('/api/wxoa/mass-jobs')
        .set(bearer(ctx.admin))
        .send({ accountId: account.id, ...dto })
        .expect(201)
      expect(response.body.data).toMatchObject({
        accountId: account.id,
        targetKind: body.targetKind,
        msgKind: body.msgKind,
        wxMsgId: String(34182 + index),
        msgDataId: String(206227730 + index),
        jobState: 'submitted',
        clientMsgId: `qw-${response.body.data.id}`,
      })
      const call = ctx.fake.callsTo(path).at(-1)!
      expect(call.body).toEqual({
        ...expected,
        clientmsgid: response.body.data.clientMsgId,
        send_ignore_reprint: 'sendIgnoreReprint' in body ? 1 : 0,
      })
    }
    // 图文群发后微信作废草稿的 media_id：本地草稿不再带它，显示为未同步
    const [draft] = await ctx.ds.query(
      'SELECT media_id, synced_digest FROM wxoa_draft WHERE id = ?',
      [draftId],
    )
    expect(draft).toEqual({ media_id: null, synced_digest: null })
    const detail = await http()
      .get(`/api/wxoa/drafts/${draftId}`)
      .set(bearer(ctx.admin))
      .expect(200)
    expect(detail.body.data.dirty).toBe(true)
  })

  it('previews one fan in the preview format and records the preview message', async () => {
    ctx.fake.reset()
    ctx.fake.on('/cgi-bin/message/mass/preview', { errcode: 0, errmsg: 'preview success' })
    const preview = (payload: Record<string, unknown>, msgKind = 'image') =>
      http()
        .post('/api/wxoa/mass-jobs/preview')
        .set(bearer(ctx.admin))
        .send({ accountId: account.id, toOpenId: openIds[0], targetKind: 'all', msgKind, payload })
    const response = await preview({ media_id: 'preview-img' }).expect(201)
    expect(response.body.data).toEqual({ channel: 'preview' })
    expect(ctx.fake.callsTo('/cgi-bin/message/mass/preview')[0]?.body).toEqual({
      touser: openIds[0],
      msgtype: 'image',
      image: { media_id: 'preview-img' },
    })
    // 同一预览 3 秒内重复提交被拦下
    const duplicate = await preview({ media_id: 'preview-img' })
    expect(duplicate.status).toBe(429)
    expect(ctx.fake.callsTo('/cgi-bin/message/mass/preview')).toHaveLength(1)
    const rows = await ctx.ds.query(
      "SELECT open_id, msg_kind, send_state, wx_msg_id FROM wxoa_message WHERE account_id = ? AND channel = 'preview'",
      [account.id],
    )
    expect(rows).toEqual([
      { open_id: openIds[0], msg_kind: 'image', send_state: 'sent', wx_msg_id: null },
    ])
    await preview({}, 'voice').expect(400)
  })

  it('settles official MASSSENDJOBFINISH receipts by numeric msg ids and whitelists upstream status', async () => {
    ctx.fake.reset()
    ctx.fake.on('/cgi-bin/message/mass/sendall', { msg_id: 1000001625, msg_data_id: 2247490098 })
    const sent = await sendText('receipt success').expect(201)
    expect(sent.body.data.wxMsgId).toBe('1000001625')
    await ctx.app.get(WxoaInboundHub).emit({
      id: 9201,
      accountId: account.id,
      tenantId: 1,
      openId: 'mphelper',
      msgKind: 'event',
      eventKind: 'MASSSENDJOBFINISH',
      eventKey: null,
      wxMsgId: '1000001625',
      payload: {
        MsgID: '1000001625',
        Status: 'send success',
        TotalCount: '2',
        FilterCount: '2',
        SentCount: '2',
        ErrorCount: '0',
        CopyrightCheckResult: { Count: '0', CheckState: '1' },
      },
      occurredAt: new Date(),
    })
    ctx.fake.on('/cgi-bin/message/mass/get', {
      msg_id: 1000001625,
      msg_status: 'SEND_SUCCESS',
      secret_field: 'never forwarded',
    })
    const status = await http()
      .get(`/api/wxoa/mass-jobs/${sent.body.data.id}`)
      .set(bearer(ctx.admin))
      .expect(200)
    expect(ctx.fake.callsTo('/cgi-bin/message/mass/get')[0]?.body).toEqual({ msg_id: '1000001625' })
    expect(status.body.data).toMatchObject({
      jobState: 'succeeded',
      result: { status: 'send success', totalCount: 2, sentCount: 2, errorCount: 0, checkState: 1 },
      upstream: { msgId: '1000001625', msgStatus: 'SEND_SUCCESS' },
    })
    expect(JSON.stringify(status.body.data.upstream)).not.toContain('secret_field')

    ctx.fake.on('/cgi-bin/message/mass/sendall', { msg_id: 1000001626 })
    const failed = await sendText('receipt failed').expect(201)
    await ctx.app.get(WxoaInboundHub).emit({
      id: 9202,
      accountId: account.id,
      tenantId: 1,
      openId: 'mphelper',
      msgKind: 'event',
      eventKind: 'MASSSENDJOBFINISH',
      eventKey: null,
      wxMsgId: '1000001626',
      payload: { MsgID: '1000001626', Status: 'err(30003)' },
      occurredAt: new Date(),
    })
    const row = (
      await ctx.ds.query('SELECT job_state FROM wxoa_mass_job WHERE id = ?', [failed.body.data.id])
    )[0]
    expect(row.job_state).toBe('failed')
  })

  it('marks a refused submission failed and retries an unknown outcome with the same clientmsgid', async () => {
    ctx.fake.reset()
    ctx.fake.on('/cgi-bin/message/mass/sendall', upstreamError(40007))
    const refused = await sendText('refused by wechat')
    expect(refused.status).toBe(422)
    expect(refused.body.code).toBe(Err.WXOA_UPSTREAM_REFUSED.code)
    const [failedRow] = await ctx.ds.query(
      "SELECT id, job_state, result FROM wxoa_mass_job WHERE account_id = ? AND JSON_EXTRACT(payload, '$.content') = 'refused by wechat'",
      [account.id],
    )
    expect(failedRow.job_state).toBe('failed')
    expect(
      typeof failedRow.result === 'string' ? JSON.parse(failedRow.result) : failedRow.result,
    ).toEqual({ errcode: 40007 })
    await http()
      .post(`/api/wxoa/mass-jobs/${failedRow.id}/retry`)
      .set(bearer(ctx.admin))
      .expect(409)

    ctx.fake.on('/cgi-bin/message/mass/sendall', new BizError(Err.WXOA_UPSTREAM))
    const timeout = await sendText('timed out')
    expect(timeout.status).toBe(502)
    const [pending] = await ctx.ds.query(
      "SELECT id, job_state, wx_msg_id, client_msg_id FROM wxoa_mass_job WHERE account_id = ? AND JSON_EXTRACT(payload, '$.content') = 'timed out'",
      [account.id],
    )
    expect(pending).toMatchObject({ job_state: 'submitted', wx_msg_id: null })
    expect(pending.client_msg_id).toBe(`qw-${pending.id}`)

    // 微信已收下前一次请求：45065 表示同一 clientmsgid 已有群发，任务保持 submitted，不建新任务
    ctx.fake.on('/cgi-bin/message/mass/sendall', upstreamError(45065))
    await http().post(`/api/wxoa/mass-jobs/${pending.id}/retry`).set(bearer(ctx.admin)).expect(201)
    // 带上次 msg_id 的 45065 应答由网关原样交回：任务记下这个 msg_id
    ctx.fake.on('/cgi-bin/message/mass/sendall', {
      errcode: 45065,
      errmsg: 'clientmsgid exist',
      msg_id: 1000001700,
    })
    await new Promise((resolve) => setTimeout(resolve, 3100))
    const retried = await http()
      .post(`/api/wxoa/mass-jobs/${pending.id}/retry`)
      .set(bearer(ctx.admin))
      .expect(201)
    expect(retried.body.data).toMatchObject({
      id: pending.id,
      wxMsgId: '1000001700',
      jobState: 'submitted',
    })
    const calls = ctx.fake.callsTo('/cgi-bin/message/mass/sendall').slice(-3)
    expect(calls.map((c) => (c.body as { clientmsgid: string }).clientmsgid)).toEqual([
      pending.client_msg_id,
      pending.client_msg_id,
      pending.client_msg_id,
    ])
    const count = await ctx.ds.query(
      "SELECT COUNT(*) AS n FROM wxoa_mass_job WHERE account_id = ? AND JSON_EXTRACT(payload, '$.content') = 'timed out'",
      [account.id],
    )
    expect(Number(count[0].n)).toBe(1)
  })

  it('refuses a retry past the 23-hour clientmsgid window with its own code', async () => {
    ctx.fake.reset()
    ctx.fake.on('/cgi-bin/message/mass/sendall', new BizError(Err.WXOA_UPSTREAM))
    expect((await sendText('too late to retry')).status).toBe(502)
    const [pending] = await ctx.ds.query(
      "SELECT id FROM wxoa_mass_job WHERE account_id = ? AND JSON_EXTRACT(payload, '$.content') = 'too late to retry'",
      [account.id],
    )
    await ctx.ds.query(
      'UPDATE wxoa_mass_job SET created_at = created_at - INTERVAL 24 HOUR WHERE id = ?',
      [pending.id],
    )
    const late = await http().post(`/api/wxoa/mass-jobs/${pending.id}/retry`).set(bearer(ctx.admin))
    expect(late.status).toBe(409)
    expect(late.body.code).toBe(Err.WXOA_MASS_RETRY_EXPIRED.code)
    expect(ctx.fake.callsTo('/cgi-bin/message/mass/sendall')).toHaveLength(1)
  })

  it('stores and sends the de-duplicated openid list; one left after that is 400', async () => {
    ctx.fake.reset()
    ctx.fake.on('/cgi-bin/message/mass/send', { msg_id: 1000001900 })
    const send = (list: string[], content: string) =>
      http().post('/api/wxoa/mass-jobs').set(bearer(ctx.admin)).send({
        accountId: account.id,
        targetKind: 'openids',
        openIds: list,
        msgKind: 'text',
        payload: { content },
      })
    const sent = await send([openIds[0]!, openIds[1]!, openIds[0]!], 'dedup').expect(201)
    expect(sent.body.data.openIds).toEqual(openIds)
    expect(ctx.fake.callsTo('/cgi-bin/message/mass/send')[0]?.body).toMatchObject({
      touser: openIds,
    })
    await send([openIds[0]!, openIds[0]!], 'dedup to one').expect(400)
    expect(ctx.fake.callsTo('/cgi-bin/message/mass/send')).toHaveLength(1)
  })

  it('rejects duplicate submission, bad targets, missing media and unsynced drafts', async () => {
    ctx.fake.reset()
    ctx.fake.on('/cgi-bin/message/mass/sendall', { msg_id: 1000001800 })
    const content = `idempotent-${Date.now()}`
    await sendText(content).expect(201)
    const duplicate = await sendText(content)
    expect(duplicate.status).toBe(429)
    expect(duplicate.body.code).toBe(Err.TOO_MANY_REQUESTS.code)
    expect(ctx.fake.callsTo('/cgi-bin/message/mass/sendall')).toHaveLength(1)

    const send = (body: Record<string, unknown>) =>
      http()
        .post('/api/wxoa/mass-jobs')
        .set(bearer(ctx.admin))
        .send({ accountId: account.id, msgKind: 'text', payload: { content: 'x' }, ...body })
    await send({ targetKind: 'tag', tagId: 89, payload: { content: 'foreign tag' } }).expect(404)
    await send({
      targetKind: 'openids',
      openIds: ['mass-foreign-openid', openIds[0]],
      payload: { content: 'foreign openid' },
    }).expect(404)
    await send({ targetKind: 'openids', openIds: ['only-one'] }).expect(400)
    await send({
      targetKind: 'openids',
      openIds: Array.from({ length: 10_001 }, () => 'a'),
    }).expect(400)
    await send({ targetKind: 'all', msgKind: 'image', payload: { mediaId: 'camel' } }).expect(400)

    const unsynced = await http()
      .post('/api/wxoa/drafts')
      .set(bearer(ctx.admin))
      .send({
        accountId: account.id,
        articles: [
          {
            title: 'unsynced',
            author: '',
            digest: '',
            content: '<p>unsynced</p>',
            thumbMediaId: 'mass-cover',
            needOpenComment: true,
            onlyFansCanComment: false,
          },
        ],
      })
      .expect(201)
    const unsyncedResponse = await send({
      targetKind: 'all',
      msgKind: 'mpnews',
      draftId: unsynced.body.data.id,
      payload: {},
    }).expect(409)
    expect(unsyncedResponse.body.code).toBe(Err.WXOA_DRAFT_UNSYNCED.code)
  })

  it('lists only the queried account, removes a job and requires the mass permission', async () => {
    ctx.fake.reset()
    ctx.fake.on('/cgi-bin/message/mass/sendall', { msg_id: 30124 })
    const sent = await sendText('remove me').expect(201)
    await ctx.ds.query(
      `INSERT INTO wxoa_mass_job (tenant_id, account_id, target_kind, msg_kind, payload, client_msg_id, job_state)
       VALUES (1, ?, 'all', 'text', '{}', 'qw-foreign', 'submitted')`,
      [foreignAccount.id],
    )
    const page = await http()
      .get('/api/wxoa/mass-jobs')
      .set(bearer(reader))
      .query({ accountId: account.id, pageSize: 100 })
      .expect(200)
    expect(
      page.body.data.items.every((r: { accountId: number }) => r.accountId === account.id),
    ).toBe(true)
    ctx.fake.on('/cgi-bin/message/mass/delete', { errcode: 0 })
    await http()
      .delete(`/api/wxoa/mass-jobs/${sent.body.data.id}`)
      .query({ index: 2 })
      .set(bearer(ctx.admin))
      .expect(200)
    await http()
      .delete(`/api/wxoa/mass-jobs/${sent.body.data.id}`)
      .set(bearer(ctx.admin))
      .expect(200)
    expect(ctx.fake.callsTo('/cgi-bin/message/mass/delete').map((c) => c.body)).toEqual([
      { msg_id: 30124, article_idx: 2 },
      { msg_id: 30124, article_idx: 0 },
    ])
    const row = (
      await ctx.ds.query('SELECT job_state FROM wxoa_mass_job WHERE id = ?', [sent.body.data.id])
    )[0]
    expect(row.job_state).toBe('removed')
    await http()
      .post('/api/wxoa/mass-jobs')
      .set(bearer(reader))
      .send({
        accountId: account.id,
        targetKind: 'all',
        msgKind: 'text',
        payload: { content: 'no send permission' },
      })
      .expect(403)
  })
})
