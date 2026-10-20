import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  type WxoaNoticeAdd,
  type WxoaNoticeLibraryQuery,
  type WxoaNoticeQuery,
  type WxoaNoticeSend,
  wxoaTemplateValueMax,
} from '@qiwu/shared'
import { In, IsNull } from 'typeorm'
import { REDIS, type Redis } from '../../../../core/redis/redis.module.js'
import { redisKey } from '../../../../core/redis/cache-namespaces.js'
import { WxoaFan, WxoaMessage } from '../core/wxoa.entity.js'
import { WxoaGateway, type WxoaJson } from '../core/wxoa-gateway.js'
import { WxoaInboundHub, type WxoaInbound } from '../core/wxoa-inbound-hub.js'
import { jsonObject, textOf, upstreamErrcode, activeAccount } from '../core/wxoa-util.js'
import { WXOA_NOTICE_EVENTS } from '../core/wxoa-xml.js'

const TTL = 600
/** 公共模板标题每页最多 30 条（官方上限）。 */
const TITLE_PAGE = 30

/** 上游数组字段，非数组视为空。 */
const arrayOf = (v: unknown): WxoaJson[] =>
  Array.isArray(v) ? v.map(jsonObject) : v && typeof v === 'object' ? [jsonObject(v)] : []

/**
 * 订阅通知（newtmpl 接口族，与模板消息的 `/cgi-bin/template/*` 完全分开）：
 * 模板库、选用与删除模板、我的模板缓存、bizsend 发送及三种订阅事件的记录。
 */
@Injectable()
export class WxoaNoticeService implements OnModuleInit {
  constructor(
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly gateway: WxoaGateway,
    private readonly hub: WxoaInboundHub,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}
  onModuleInit() {
    this.hub.on((row) => this.event(row))
  }
  /** 我的订阅通知模板（gettemplate），缓存 10 分钟，`refresh` 跳过缓存。 */
  async list(q: WxoaNoticeQuery) {
    const account = await activeAccount(this.txHost, q.accountId)
    const key = redisKey('wxoa', 'notice-tpl', account.id)
    if (!q.refresh) {
      const cached = await this.redis.get(key)
      if (cached) return JSON.parse(cached)
    }
    const answer = await this.gateway.json(account, '/wxaapi/newtmpl/gettemplate')
    const result = arrayOf(answer.data).map((x) => ({
      priTmplId: textOf(x.priTmplId),
      title: textOf(x.title),
      content: textOf(x.content),
      example: textOf(x.example) || null,
      type: typeof x.type === 'number' ? x.type : null,
    }))
    await this.redis.set(key, JSON.stringify(result), { expiration: { type: 'EX', value: TTL } })
    return result
  }
  /**
   * 公共模板库：带 tid 取关键词，带 categoryId 取该类目的模板标题（每页 30），都不带取类目。
   * 只回传白名单字段：`{ keywords }` / `{ titles, total }` / `{ categories }`。
   */
  async library(q: WxoaNoticeLibraryQuery) {
    const account = await activeAccount(this.txHost, q.accountId)
    if (q.tid !== undefined) {
      const answer = await this.gateway.json(account, '/wxaapi/newtmpl/getpubtemplatekeywords', {
        query: { tid: q.tid },
      })
      const keywords = arrayOf(answer.data).map((x) => ({
        kid: Number(textOf(x.kid)),
        name: textOf(x.name),
        example: textOf(x.example),
        rule: textOf(x.rule),
      }))
      return { keywords }
    }
    if (q.categoryId !== undefined) {
      const answer = await this.gateway.json(account, '/wxaapi/newtmpl/getpubtemplatetitles', {
        query: { ids: String(q.categoryId), start: q.start, limit: TITLE_PAGE },
      })
      const titles = arrayOf(answer.data).map((x) => ({
        tid: textOf(x.tid),
        title: textOf(x.title),
        type: Number(textOf(x.type)) || null,
        categoryId: textOf(x.categoryId),
      }))
      return { titles, total: Number(textOf(answer.count)) || titles.length }
    }
    const answer = await this.gateway.json(account, '/wxaapi/newtmpl/getcategory')
    return {
      categories: arrayOf(answer.data).map((x) => ({ id: textOf(x.id), name: textOf(x.name) })),
    }
  }
  /** 从公共模板库选用模板（addtemplate），成功后清掉我的模板缓存。 */
  async add(dto: WxoaNoticeAdd) {
    const account = await activeAccount(this.txHost, dto.accountId)
    const answer = await this.gateway.json(account, '/wxaapi/newtmpl/addtemplate', {
      body: { tid: dto.tid, kidList: dto.kidList, sceneDesc: dto.sceneDesc },
    })
    await this.redis.unlink(redisKey('wxoa', 'notice-tpl', account.id))
    return { priTmplId: textOf(answer.priTmplId) }
  }
  /** 删除订阅通知模板（deltemplate）：只走 newtmpl 接口，绝不触及模板消息的模板。 */
  async remove(accountId: number, priTmplId: string) {
    const account = await activeAccount(this.txHost, accountId)
    await this.gateway.json(account, '/wxaapi/newtmpl/deltemplate', { body: { priTmplId } })
    await this.redis.unlink(redisKey('wxoa', 'notice-tpl', account.id))
  }
  /**
   * 发送订阅通知：先为每个粉丝建 pending 行，再逐个调用 bizsend；失败行记下 errcode，
   * 遇到 45009（当日额度用尽）立即停止，剩余的行一并标为失败并抛出该错误；全部失败时抛出最后
   * 一个错误，部分失败时返回各行状态。
   */
  async send(templateId: string, dto: WxoaNoticeSend, operatorId: number) {
    const account = await activeAccount(this.txHost, dto.accountId)
    const fanIds = [...new Set(dto.fanIds)]
    const fans = await this.txHost.tx.getRepository(WxoaFan).find({
      select: { id: true, openId: true },
      where: { id: In(fanIds), accountId: account.id },
      order: { id: 'ASC' },
    })
    if (fans.length !== fanIds.length) throw new NotFoundException()
    // 订阅通知的字段上限按关键词类型计算；schema 只能约束通用 200 字符，这里补上微信的细粒度边界并返回 400。
    for (const [key, value] of Object.entries(dto.data))
      if ([...value].length > wxoaTemplateValueMax(key, value)) throw new BadRequestException()
    const repo = this.txHost.tx.getRepository(WxoaMessage)
    const payload = { templateId, data: dto.data, url: dto.url ?? null }
    const rows = await repo.save(
      fans.map((f) =>
        repo.create({
          accountId: account.id,
          openId: f.openId,
          direction: 'out',
          channel: 'notice',
          msgKind: 'subscribe',
          eventKind: null,
          eventKey: null,
          payload,
          objectId: null,
          wxMsgId: null,
          dedupKey: null,
          sendState: 'pending',
          errcode: null,
          operatorId,
          occurredAt: new Date(),
        }),
      ),
    )
    // 官方 data 格式为 { 关键词: { value } }，page 是点击通知后打开的网页
    const data = Object.fromEntries(
      Object.entries(dto.data).map(([k, value]) => [k.replace(/\.DATA$/, ''), { value }]),
    )
    let failure: unknown = null
    let sent = 0
    for (const [i, fan] of fans.entries()) {
      try {
        await this.gateway.json(account, '/cgi-bin/message/subscribe/bizsend', {
          body: {
            touser: fan.openId,
            template_id: templateId,
            data,
            ...(dto.url ? { page: dto.url } : {}),
          },
        })
        await repo.update(rows[i]!.id, { sendState: 'sent', errcode: 0 })
        sent++
      } catch (err) {
        const errcode = upstreamErrcode(err)
        await repo.update(rows[i]!.id, { sendState: 'failed', errcode })
        failure = err
        if (errcode === 45009) {
          await repo.update(
            { id: In(rows.slice(i + 1).map((r) => r.id)), sendState: 'pending' },
            { sendState: 'failed', errcode },
          )
          throw err
        }
      }
    }
    if (failure && !sent) throw failure
    return repo.find({ where: { id: In(rows.map((r) => r.id)) }, order: { id: 'ASC' } })
  }
  /**
   * 三种订阅通知事件：回调已写入一行入站消息，这里只把它归到 notice 渠道（不另插行、不写粉丝行）；
   * 发送结果事件按 List 里的 TemplateId 找到该粉丝最近一条未回执的发送行，写入 MsgID 与结果。
   */
  private async event(row: WxoaInbound) {
    const wrapper = WXOA_NOTICE_EVENTS[row.eventKind ?? '']
    if (!wrapper) return
    const repo = this.txHost.tx.getRepository(WxoaMessage)
    await repo.update({ id: row.id, accountId: row.accountId }, { channel: 'notice' })
    if (row.eventKind !== 'subscribe_msg_sent_event' || !row.openId) return
    for (const item of arrayOf(jsonObject(row.payload[wrapper]).List)) {
      const msgId = textOf(item.MsgID)
      const templateId = textOf(item.TemplateId)
      if (!msgId || !templateId) continue
      // 上限：只看该粉丝最近 20 条未回执的发送行，足够覆盖一次 ≤ 20 人的发送
      // 只认微信已收下（sent）的行：被拒或未发出的行不会有发送结果事件，不能被它认领
      const candidates = await repo.find({
        where: {
          accountId: row.accountId,
          openId: row.openId,
          direction: 'out',
          channel: 'notice',
          sendState: 'sent',
          wxMsgId: IsNull(),
        },
        order: { id: 'DESC' },
        take: 20,
      })
      const target = candidates.find((c) => jsonObject(c.payload).templateId === templateId)
      if (!target) continue
      const code = Number(textOf(item.ErrorCode) || '0')
      await repo.update(target.id, {
        wxMsgId: msgId.slice(0, 24),
        errcode: Number.isInteger(code) ? code : null,
        sendState: code === 0 ? 'sent' : 'failed',
      })
    }
  }
}
