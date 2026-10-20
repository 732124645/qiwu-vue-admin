import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { Err } from '@qiwu/shared'
import { upstreamError } from '../../src/modules/platform/wxoa/core/wxoa-gateway.js'
import {
  WxoaInboundHub,
  type WxoaInbound,
} from '../../src/modules/platform/wxoa/core/wxoa-inbound-hub.js'
import { bearer } from '../setup/auth.js'
import {
  addAccount,
  addContentUser,
  closeContentApp,
  openContentApp,
} from './wxoa-content.helpers.js'

describe('wxoa subscription notices', () => {
  let ctx: Awaited<ReturnType<typeof openContentApp>>
  const ids: number[] = []
  const roleIds: number[] = []
  const userIds: number[] = []
  let account: { id: number }
  let other: { id: number }
  let fanId: number
  let otherFanId: number
  let plainToken = ''
  const http = () => request(ctx.app.getHttpServer())
  const send = (body: Record<string, unknown>) =>
    http()
      .post('/api/wxoa/notice-templates/pt1/send')
      .set(bearer(ctx.admin))
      .send({ accountId: account.id, ...body })

  beforeAll(async () => {
    ctx = await openContentApp()
    account = await addAccount(ctx)
    ids.push(account.id)
    other = await addAccount(ctx)
    ids.push(other.id)
    const r = await ctx.ds.query(
      "INSERT INTO wxoa_fan (tenant_id, account_id, open_id, subscribed) VALUES (1, ?, 'notice-open-1', 1)",
      [account.id],
    )
    fanId = Number(r.insertId)
    const otherFan = await ctx.ds.query(
      "INSERT INTO wxoa_fan (tenant_id, account_id, open_id, subscribed) VALUES (1, ?, 'notice-open-2', 1)",
      [other.id],
    )
    otherFanId = Number(otherFan.insertId)
    // 无公众号权限的真实会话，覆盖守卫而不是只测管理员路径
    const plain = await addContentUser(ctx, [])
    plainToken = plain.accessToken
    userIds.push(plain.userId)
    roleIds.push(plain.roleId)
  })
  afterAll(async () => closeContentApp(ctx, ids, userIds, roleIds))

  it('lists subscribe-notice templates with a ten-minute cache and sends in the bizsend format', async () => {
    ctx.fake.reset()
    ctx.fake.on('/wxaapi/newtmpl/gettemplate', {
      errcode: 0,
      data: [
        { priTmplId: 'pt1', title: 'Notice', content: '{{thing1.DATA}}', example: 'Ex', type: 2 },
      ],
    })
    const first = await http()
      .get('/api/wxoa/notice-templates')
      .set(bearer(ctx.admin))
      .query({ accountId: account.id, refresh: 'true' })
      .expect(200)
    expect(first.body.data).toEqual([
      { priTmplId: 'pt1', title: 'Notice', content: '{{thing1.DATA}}', example: 'Ex', type: 2 },
    ])
    expect(ctx.fake.callsTo('/wxaapi/newtmpl/gettemplate')[0]?.body).toBeUndefined()
    await http()
      .get('/api/wxoa/notice-templates')
      .set(bearer(ctx.admin))
      .query({ accountId: account.id })
      .expect(200)
    expect(ctx.fake.callsTo('/wxaapi/newtmpl/gettemplate')).toHaveLength(1)
    // bizsend 只回 errcode；MsgID 由发送结果事件带回
    ctx.fake.on('/cgi-bin/message/subscribe/bizsend', { errcode: 0, errmsg: 'ok' })
    const sent = await send({
      fanIds: [fanId],
      data: { thing1: 'hello' },
      url: 'https://example.com/notice',
    }).expect(201)
    expect(sent.body.data[0]).toMatchObject({ sendState: 'sent', errcode: 0, wxMsgId: null })
    expect(ctx.fake.callsTo('/cgi-bin/message/subscribe/bizsend')[0]?.body).toEqual({
      touser: 'notice-open-1',
      template_id: 'pt1',
      data: { thing1: { value: 'hello' } },
      page: 'https://example.com/notice',
    })
    await send({ fanIds: [fanId], data: { thing1: 'x' }, url: 'javascript:alert(1)' }).expect(400)
  })

  it('requires a valid account for template operations', async () => {
    const missing = await http()
      .get('/api/wxoa/notice-templates')
      .set(bearer(ctx.admin))
      .query({ accountId: 999999999 })
    expect(missing.status).toBe(404)
  })

  it('reads the template library in whitelisted shapes and adds or removes templates without touching template messages', async () => {
    ctx.fake.reset()
    ctx.fake.on('/wxaapi/newtmpl/getcategory', { errcode: 0, data: [{ id: 616, name: '公交' }] })
    const categories = await http()
      .get('/api/wxoa/notice-templates/library')
      .set(bearer(ctx.admin))
      .query({ accountId: account.id })
      .expect(200)
    expect(categories.body.data).toEqual({ categories: [{ id: '616', name: '公交' }] })
    ctx.fake.on('/wxaapi/newtmpl/getpubtemplatetitles', {
      errcode: 0,
      count: 55,
      data: [{ tid: 99, title: '付款成功通知', type: 2, categoryId: '616', extra: 'x' }],
    })
    const titles = await http()
      .get('/api/wxoa/notice-templates/library')
      .set(bearer(ctx.admin))
      .query({ accountId: account.id, categoryId: 616, start: 30 })
      .expect(200)
    expect(titles.body.data).toEqual({
      titles: [{ tid: '99', title: '付款成功通知', type: 2, categoryId: '616' }],
      total: 55,
    })
    const titleCall = ctx.fake.callsTo('/wxaapi/newtmpl/getpubtemplatetitles')[0]!
    expect(titleCall.query).toEqual({ ids: '616', start: 30, limit: 30 })
    expect(titleCall.body).toBeUndefined()
    ctx.fake.on('/wxaapi/newtmpl/getpubtemplatekeywords', {
      errcode: 0,
      data: [{ kid: 1, name: '物品名称', example: '名称', rule: 'thing' }],
    })
    const keywords = await http()
      .get('/api/wxoa/notice-templates/library')
      .set(bearer(ctx.admin))
      .query({ accountId: account.id, tid: '99' })
      .expect(200)
    expect(keywords.body.data).toEqual({
      keywords: [{ kid: 1, name: '物品名称', example: '名称', rule: 'thing' }],
    })
    expect(ctx.fake.callsTo('/wxaapi/newtmpl/getpubtemplatekeywords')[0]?.query).toEqual({
      tid: '99',
    })

    ctx.fake.on('/wxaapi/newtmpl/gettemplate', {
      data: [{ priTmplId: 'pt1', title: 'Before', content: '{{thing1.DATA}}' }],
    })
    await http()
      .get('/api/wxoa/notice-templates')
      .set(bearer(ctx.admin))
      .query({ accountId: account.id, refresh: 'true' })
      .expect(200)
    ctx.fake.on('/wxaapi/newtmpl/addtemplate', { errcode: 0, priTmplId: 'pt2' })
    const add = (kidList: number[]) =>
      http()
        .post('/api/wxoa/notice-templates')
        .set(bearer(ctx.admin))
        .send({ accountId: account.id, tid: '99', kidList, sceneDesc: '付款提醒' })
    const added = await add([1, 2]).expect(201)
    expect(added.body.data).toEqual({ priTmplId: 'pt2' })
    expect(ctx.fake.callsTo('/wxaapi/newtmpl/addtemplate')[0]?.body).toEqual({
      tid: '99',
      kidList: [1, 2],
      sceneDesc: '付款提醒',
    })
    await add([1]).expect(400)
    ctx.fake.on('/wxaapi/newtmpl/gettemplate', {
      data: [{ priTmplId: 'pt2', title: 'After add', content: '{{thing1.DATA}}' }],
    })
    const afterAdd = await http()
      .get('/api/wxoa/notice-templates')
      .set(bearer(ctx.admin))
      .query({ accountId: account.id })
      .expect(200)
    expect(afterAdd.body.data[0].priTmplId).toBe('pt2')
    ctx.fake.on('/wxaapi/newtmpl/deltemplate', { errcode: 0 })
    await http()
      .delete('/api/wxoa/notice-templates/pt2')
      .set(bearer(ctx.admin))
      .query({ accountId: account.id })
      .expect(200)
    expect(ctx.fake.callsTo('/wxaapi/newtmpl/deltemplate')[0]?.body).toEqual({ priTmplId: 'pt2' })
    // 订阅通知只用 newtmpl：模板消息的 /cgi-bin/template/* 一次都不碰
    expect(ctx.fake.calls.filter((c) => c.path.startsWith('/cgi-bin/template/'))).toEqual([])
    ctx.fake.on('/wxaapi/newtmpl/gettemplate', { data: [] })
    const afterDelete = await http()
      .get('/api/wxoa/notice-templates')
      .set(bearer(ctx.admin))
      .query({ accountId: account.id })
      .expect(200)
    expect(afterDelete.body.data).toEqual([])
  })

  it('sends at most twenty deduplicated fans, stores errcodes, stops on the daily quota and rejects foreign fans', async () => {
    ctx.fake.reset()
    const extra: number[] = []
    for (const openId of ['notice-open-3', 'notice-open-4']) {
      const r = await ctx.ds.query(
        'INSERT INTO wxoa_fan (tenant_id, account_id, open_id, subscribed) VALUES (1, ?, ?, 1)',
        [account.id, openId],
      )
      extra.push(Number(r.insertId))
    }
    ctx.fake.on('/cgi-bin/message/subscribe/bizsend', {}, upstreamError(43101))
    const partly = await send({ fanIds: [fanId, extra[0], fanId], data: { thing1: 'partly' } })
    expect(partly.status).toBe(201)
    expect(
      partly.body.data.map((r: { sendState: string; errcode: number }) => [r.sendState, r.errcode]),
    ).toEqual([
      ['sent', 0],
      ['failed', 43101],
    ])
    const touser = (c: { body?: unknown }) => (c.body as { touser: string }).touser
    expect(ctx.fake.callsTo('/cgi-bin/message/subscribe/bizsend').map(touser)).toEqual([
      'notice-open-1',
      'notice-open-3',
    ])

    ctx.fake.reset()
    ctx.fake.on('/cgi-bin/message/subscribe/bizsend', {}, upstreamError(45009))
    const quota = await send({ fanIds: [fanId, ...extra], data: { thing1: 'quota' } })
    expect(quota.status).toBe(429)
    expect(quota.body.code).toBe(Err.WXOA_QUOTA_EXCEEDED.code)
    expect(ctx.fake.callsTo('/cgi-bin/message/subscribe/bizsend')).toHaveLength(2)
    const rows = await ctx.ds.query(
      "SELECT open_id, send_state, errcode FROM wxoa_message WHERE account_id = ? AND channel = 'notice' AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.data.thing1')) = 'quota' ORDER BY id",
      [account.id],
    )
    expect(rows).toEqual([
      { open_id: 'notice-open-1', send_state: 'sent', errcode: 0 },
      { open_id: 'notice-open-3', send_state: 'failed', errcode: 45009 },
      { open_id: 'notice-open-4', send_state: 'failed', errcode: 45009 },
    ])

    await send({ fanIds: [otherFanId], data: { thing1: 'hello' } }).expect(404)
    await send({ fanIds: [], data: { thing1: 'hello' } }).expect(400)
    await send({ fanIds: [fanId], data: { thing1: 'x'.repeat(21) } }).expect(400)
  })

  it('files the callback rows of notice events under the notice channel and settles sends from the nested List', async () => {
    ctx.fake.reset()
    const hub = ctx.app.get(WxoaInboundHub)
    const count = async (table: 'wxoa_fan' | 'wxoa_message') =>
      Number(
        (
          await ctx.ds.query(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id = ?`, [
            account.id,
          ])
        )[0].n,
      )
    const beforeFans = await count('wxoa_fan')
    // 回调写好的入站行（渠道 push），再交给 hub，与回调的顺序相同
    let seq = 0
    const inbound = async (eventKind: string, payload: Record<string, unknown>) => {
      const r = await ctx.ds.query(
        `INSERT INTO wxoa_message (tenant_id, account_id, open_id, direction, channel, msg_kind, event_kind, payload, dedup_key, occurred_at)
         VALUES (1, ?, 'notice-open-1', 'in', 'push', 'event', ?, ?, ?, NOW(3))`,
        [account.id, eventKind, JSON.stringify(payload), `notice-spec-${account.id}-${++seq}`],
      )
      return {
        id: Number(r.insertId),
        accountId: account.id,
        openId: 'notice-open-1',
        msgKind: 'event',
        eventKind,
        eventKey: null,
        wxMsgId: null,
        payload,
        occurredAt: new Date(),
        tenantId: 1,
      } satisfies WxoaInbound
    }
    const popup = await inbound('subscribe_msg_popup_event', {
      SubscribeMsgPopupEvent: {
        List: [
          { TemplateId: 'tpl-a', SubscribeStatusString: 'accept', PopupScene: '2' },
          { TemplateId: 'tpl-b', SubscribeStatusString: 'reject', PopupScene: '2' },
        ],
      },
    })
    const before = await count('wxoa_message')
    await hub.emit(popup)
    await hub.emit(popup)
    expect(await count('wxoa_message')).toBe(before)
    const [stored] = await ctx.ds.query('SELECT channel FROM wxoa_message WHERE id = ?', [popup.id])
    expect(stored.channel).toBe('notice')

    // 发送结果事件：MsgID 与结果写到该粉丝同一模板最近一条未回执的发送行
    const outbound = async (templateId: string, sendState = 'sent') =>
      Number(
        (
          await ctx.ds.query(
            `INSERT INTO wxoa_message (tenant_id, account_id, open_id, direction, channel, msg_kind, payload, send_state, errcode, occurred_at)
             VALUES (1, ?, 'notice-open-1', 'out', 'notice', 'subscribe', ?, ?, 0, NOW(3))`,
            [account.id, JSON.stringify({ templateId, data: {}, url: null }), sendState],
          )
        ).insertId,
      )
    const okId = await outbound('tpl-sent')
    // 同一模板更新的一条被微信拒绝的发送：没有发送结果事件，回执不能落到它上面
    const refusedSendId = await outbound('tpl-sent', 'failed')
    const refusedId = await outbound('tpl-other')
    await hub.emit(
      await inbound('subscribe_msg_sent_event', {
        SubscribeMsgSentEvent: {
          List: {
            TemplateId: 'tpl-sent',
            MsgID: '1700827132819554304',
            ErrorCode: '0',
            ErrorStatus: 'success',
          },
        },
      }),
    )
    await hub.emit(
      await inbound('subscribe_msg_sent_event', {
        SubscribeMsgSentEvent: {
          List: [
            {
              TemplateId: 'tpl-other',
              MsgID: '1700827132819554305',
              ErrorCode: '43101',
              ErrorStatus: 'user refuse to accept the msg',
            },
          ],
        },
      }),
    )
    const settled = await ctx.ds.query(
      'SELECT id, wx_msg_id, send_state, errcode FROM wxoa_message WHERE id IN (?) ORDER BY id',
      [[okId, refusedId]],
    )
    expect(settled).toEqual([
      { id: okId, wx_msg_id: '1700827132819554304', send_state: 'sent', errcode: 0 },
      { id: refusedId, wx_msg_id: '1700827132819554305', send_state: 'failed', errcode: 43101 },
    ])
    const [untouched] = await ctx.ds.query(
      'SELECT wx_msg_id, send_state FROM wxoa_message WHERE id = ?',
      [refusedSendId],
    )
    expect(untouched).toEqual({ wx_msg_id: null, send_state: 'failed' })
    expect(await count('wxoa_fan')).toBe(beforeFans)
  })

  it('requires notice permissions and validates the account on every route', async () => {
    const as = (token: string) => bearer(token)
    await http()
      .get('/api/wxoa/notice-templates')
      .set(as(plainToken))
      .query({ accountId: account.id })
      .expect(403)
    await http()
      .get('/api/wxoa/notice-templates/library')
      .set(as(plainToken))
      .query({ accountId: account.id })
      .expect(403)
    await http()
      .post('/api/wxoa/notice-templates')
      .set(as(plainToken))
      .send({ accountId: account.id, tid: '99', kidList: [1, 2], sceneDesc: 'x' })
      .expect(403)
    await http()
      .delete('/api/wxoa/notice-templates/pt1')
      .set(as(plainToken))
      .query({ accountId: account.id })
      .expect(403)
    await http()
      .post('/api/wxoa/notice-templates/pt1/send')
      .set(as(plainToken))
      .send({ accountId: account.id, fanIds: [fanId], data: { thing1: 'hello' } })
      .expect(403)
    const missing = await http()
      .get('/api/wxoa/notice-templates')
      .set(bearer(ctx.admin))
      .query({ accountId: 999999999 })
    expect(missing.status).toBe(404)
  })
})
