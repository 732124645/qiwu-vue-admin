import { Inject, Injectable } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { WXOA_STAT_METRICS, type WxoaStatQuery, type WxoaStatVo } from '@qiwu/shared'
import { redisKey } from '../../../../core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../../../core/redis/redis.module.js'
import { WxoaGateway } from '../core/wxoa-gateway.js'
import { jsonObject, textOf, activeAccount } from '../core/wxoa-util.js'

const DAY = 86_400_000
const day = (d: string) => new Date(`${d}T00:00:00.000Z`)
const iso = (d: Date) => d.toISOString().slice(0, 10)
/** 一个统计接口：名称（缓存键）、路径、每次最多查询的天数、计入图表的数值指标（行内或 detail 内）。 */
type StatSpec = [name: string, path: string, maxDays: number, metrics: readonly string[]]

const ranges = (from: Date, to: Date, maxDays: number) => {
  const out: [string, string][] = []
  for (let p = from; p <= to;) {
    const end = new Date(Math.min(to.getTime(), p.getTime() + (maxDays - 1) * DAY))
    out.push([iso(p), iso(end)])
    p = new Date(end.getTime() + DAY)
  }
  return out
}

@Injectable()
export class WxoaStatService {
  constructor(
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly gateway: WxoaGateway,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}
  /** 查询用户增减与累计数据，两个官方接口各自限制七天窗口。 */
  users(q: WxoaStatQuery) {
    const [newUser, cancelUser, cumulateUser] = WXOA_STAT_METRICS.users
    return this.collect(q, [
      // 增减数据按来源渠道分行，这里按天合计；路径没有 /cgi-bin 前缀
      ['summary', '/datacube/getusersummary', 7, [newUser, cancelUser]],
      ['cumulate', '/datacube/getusercumulate', 7, [cumulateUser]],
    ])
  }
  /** 查询上行消息统计（按消息类型分行，按天合计），七天窗口串行请求。 */
  messages(q: WxoaStatQuery) {
    return this.collect(q, [
      ['upstream', '/datacube/getupstreammsg', 7, WXOA_STAT_METRICS.messages],
    ])
  }
  /** 查询接口调用统计，官方单次最多 30 天。 */
  interfaces(q: WxoaStatQuery) {
    return this.collect(q, [
      ['interfaces', '/datacube/getinterfacesummary', 30, WXOA_STAT_METRICS.interfaces],
    ])
  }
  /**
   * 查询新图文统计：只用账号级的每日汇总 getbizsummary（每次最多 30 天）。单篇文章的阅读、分享与明细
   * 接口每次只查一天，90 天要几百次调用却不进任何图表，所以不请求。
   */
  articles(q: WxoaStatQuery) {
    return this.collect(q, [['biz', '/datacube/getbizsummary', 30, WXOA_STAT_METRICS.articles]])
  }
  /**
   * 将区间拆成接口允许的窗口串行请求，今天不请求（T+1 数据），历史窗口缓存 24 小时；
   * 再把各行按 ref_date 按天合计成图表序列，没有数据的日子记 0。
   */
  private async collect(q: WxoaStatQuery, specs: StatSpec[]): Promise<WxoaStatVo> {
    const account = await activeAccount(this.txHost, q.accountId)
    const from = day(q.from)
    const to = day(q.to)
    const today = day(new Date().toISOString().slice(0, 10))
    const effectiveTo = new Date(Math.min(to.getTime(), today.getTime() - DAY))
    const dates: string[] = []
    for (let d = from; d <= effectiveTo; d = new Date(d.getTime() + DAY)) dates.push(iso(d))
    const sums = new Map<string, number[]>()
    for (const [name, path, size, metrics] of specs) {
      for (const m of metrics)
        sums.set(
          m,
          dates.map(() => 0),
        )
      for (const [start, end] of dates.length ? ranges(from, effectiveTo, size) : []) {
        const key = redisKey('wxoa', 'stat', account.id, name, start, end)
        const cached = await this.redis.get(key)
        let rows: Record<string, unknown>[]
        if (cached) rows = JSON.parse(cached) as Record<string, unknown>[]
        else {
          const answer = await this.gateway.json(account, path, {
            body: { begin_date: start, end_date: end },
          })
          // getusercumulate、getinterfacesummary 文档把 list 写成对象：单个对象也按一行处理
          rows = Array.isArray(answer.list)
            ? (answer.list as Record<string, unknown>[])
            : answer.list && typeof answer.list === 'object'
              ? [answer.list as Record<string, unknown>]
              : []
          await this.redis.set(key, JSON.stringify(rows), {
            expiration: { type: 'EX', value: 86_400 },
          })
        }
        for (const raw of rows) {
          const row = jsonObject(raw)
          const at = dates.indexOf(textOf(row.ref_date))
          if (at < 0) continue
          const detail = jsonObject(row.detail)
          for (const m of metrics) {
            const v = Number(row[m] ?? detail[m])
            const values = sums.get(m)!
            if (Number.isFinite(v)) values[at] = (values[at] ?? 0) + v
          }
        }
      }
    }
    return {
      from: q.from,
      to: q.to,
      dates,
      series: [...sums].map(([key, values]) => ({ key, values })),
    }
  }
}
