import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { Err, WXOA_STAT_METRICS } from '@qiwu/shared'
import { upstreamError } from '../../src/modules/platform/wxoa/core/wxoa-gateway.js'
import { bearer } from '../setup/auth.js'
import {
  addAccount,
  addContentUser,
  closeContentApp,
  openContentApp,
} from './wxoa-content.helpers.js'

const day = (date: string, delta: number) => {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + delta)
  return value.toISOString().slice(0, 10)
}
const beginOf = (body: unknown) => (body as { begin_date: string }).begin_date

describe('wxoa stats', () => {
  let ctx: Awaited<ReturnType<typeof openContentApp>>
  const ids: number[] = []
  const userIds: number[] = []
  const roleIds: number[] = []
  let account: { id: number }
  let plain: string
  const stats = (group: string, query: Record<string, unknown>, token = ctx.admin) =>
    request(ctx.app.getHttpServer())
      .get(`/api/wxoa/stats/${group}`)
      .set(bearer(token))
      .query({ accountId: account.id, ...query })

  beforeAll(async () => {
    ctx = await openContentApp()
    account = await addAccount(ctx)
    ids.push(account.id)
    const user = await addContentUser(ctx, [])
    plain = user.accessToken
    userIds.push(user.userId)
    roleIds.push(user.roleId)
  })

  afterAll(async () => closeContentApp(ctx, ids, userIds, roleIds))

  it('splits a thirty-day user request into seven-day windows, sums per day and caches every window', async () => {
    ctx.fake.reset()
    // 增减数据同一天按来源渠道分多行（数字字段）：按天合计，user_source 不成为序列
    ctx.fake.on('/datacube/getusersummary', ({ body }) => ({
      list: [
        { ref_date: beginOf(body), user_source: 0, new_user: 3, cancel_user: 1 },
        { ref_date: beginOf(body), user_source: 30, new_user: 2, cancel_user: 0 },
      ],
    }))
    ctx.fake.on('/datacube/getusercumulate', ({ body }) => ({
      list: [{ ref_date: beginOf(body), cumulate_user: 1217056 }],
    }))
    const q = { from: '2026-01-01', to: '2026-01-30' }
    const first = await stats('users', q).expect(200)
    const dates = Array.from({ length: 30 }, (_, i) => day('2026-01-01', i))
    const atWindowStart = (v: number) => dates.map((_, i) => (i % 7 === 0 ? v : 0))
    expect(first.body.data).toEqual({
      ...q,
      dates,
      series: [
        { key: 'new_user', values: atWindowStart(5) },
        { key: 'cancel_user', values: atWindowStart(1) },
        { key: 'cumulate_user', values: atWindowStart(1217056) },
      ],
    })
    expect(first.body.data.series.map((s: { key: string }) => s.key)).toEqual(
      WXOA_STAT_METRICS.users,
    )
    const summary = ctx.fake.callsTo('/datacube/getusersummary')
    expect(ctx.fake.callsTo('/datacube/getusercumulate')).toHaveLength(5)
    expect(ctx.fake.calls.some((c) => c.path.startsWith('/cgi-bin/'))).toBe(false)
    expect(summary.map((c) => c.body)).toEqual([
      { begin_date: '2026-01-01', end_date: '2026-01-07' },
      { begin_date: '2026-01-08', end_date: '2026-01-14' },
      { begin_date: '2026-01-15', end_date: '2026-01-21' },
      { begin_date: '2026-01-22', end_date: '2026-01-28' },
      { begin_date: '2026-01-29', end_date: '2026-01-30' },
    ])
    const totalCalls = ctx.fake.calls.length
    const second = await stats('users', q).expect(200)
    expect(ctx.fake.calls.length).toBe(totalCalls)
    expect(second.body.data).toEqual(first.body.data)
  })

  it('does not request today and trims a range ending today to yesterday', async () => {
    ctx.fake.reset()
    const today = new Date().toISOString().slice(0, 10)
    const yesterday = day(today, -1)
    ctx.fake.on('/datacube/getusersummary', { list: [{ ref_date: yesterday, new_user: 4 }] })
    // getusercumulate 的文档把 list 写成对象：单个对象也按一行处理
    ctx.fake.on('/datacube/getusercumulate', { list: { ref_date: yesterday, cumulate_user: 9 } })
    const throughToday = await stats('users', { from: yesterday, to: today }).expect(200)
    expect(throughToday.body.data).toMatchObject({
      dates: [yesterday],
      series: [
        { key: 'new_user', values: [4] },
        { key: 'cancel_user', values: [0] },
        { key: 'cumulate_user', values: [9] },
      ],
    })
    expect(ctx.fake.calls).toHaveLength(2)
    for (const call of ctx.fake.calls)
      expect(call.body).toEqual({ begin_date: yesterday, end_date: yesterday })

    ctx.fake.reset()
    const todayOnly = await stats('users', { from: today, to: today }).expect(200)
    expect(todayOnly.body.data).toMatchObject({ from: today, to: today, dates: [] })
    expect(ctx.fake.calls).toHaveLength(0)
  })

  it('uses each endpoint window size, keeps requests serial and charts numeric metrics only', async () => {
    ctx.fake.reset()
    ctx.fake.on('/datacube/getinterfacesummary', { list: [{ value: 1 }] })
    ctx.fake.on('/datacube/getupstreammsg', {
      list: [
        { ref_date: '2026-04-01', msg_type: 1, msg_user: 282, msg_count: 817 },
        { ref_date: '2026-04-01', msg_type: 2, msg_user: 10, msg_count: 12 },
      ],
    })
    const biz = {
      read_user: 4123,
      share_user: 366,
      zaikan_user: 191,
      like_user: 386,
      comment_count: 33,
      collection_user: 233,
      redirect_ori_page_user: 369,
      send_page_count: 512,
    }
    ctx.fake.on('/datacube/getbizsummary', {
      list: [
        {
          ref_date: '2026-04-02',
          detail: { ...biz, read_user_source: [{ user_count: 4123, scene_desc: 'all' }] },
        },
      ],
      is_delay: 'false',
    })
    const query = { from: '2026-04-01', to: '2026-04-02' }
    const messages = await stats('messages', query).expect(200)
    expect(messages.body.data.series).toEqual([
      { key: 'msg_user', values: [292, 0] },
      { key: 'msg_count', values: [829, 0] },
    ])
    expect(ctx.fake.callsTo('/datacube/getupstreammsg')).toHaveLength(1)
    await stats('interfaces', query).expect(200)
    expect(ctx.fake.callsTo('/datacube/getinterfacesummary')).toHaveLength(1)
    const articles = await stats('articles', query).expect(200)
    expect(articles.body.data.series).toEqual(
      WXOA_STAT_METRICS.articles.map((key) => ({ key, values: [0, biz[key]] })),
    )
    // 单篇文章的阅读、分享与明细接口不进图表，不请求；账号汇总一次取完两天
    expect(ctx.fake.calls.filter((c) => c.path.includes('article'))).toEqual([])
    expect(ctx.fake.callsTo('/datacube/getbizsummary').map((c) => c.body)).toEqual([
      { begin_date: '2026-04-01', end_date: '2026-04-02' },
    ])
  })

  it('rejects ranges over ninety days, maps 48001, enforces permission and hides foreign account ids', async () => {
    ctx.fake.reset()
    await stats('users', { from: '2026-01-01', to: '2026-04-01' }).expect(400)

    ctx.fake.on('/datacube/getusersummary', upstreamError(48001))
    const refused = await stats('users', { from: '2026-05-01', to: '2026-05-01' }).expect(422)
    expect(refused.body.code).toBe(Err.WXOA_API_UNAUTHORIZED.code)

    await stats('users', { from: '2026-05-01', to: '2026-05-01' }, plain).expect(403)
    await stats('users', { accountId: 999_999_999, from: '2026-05-01', to: '2026-05-01' }).expect(
      404,
    )
  })
})
