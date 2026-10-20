import { randomBytes } from 'node:crypto'
import { ConflictException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  Err,
  WXOA_MASS_RETRY_MS,
  type WxoaMassCreate,
  type WxoaMassPreview,
  type WxoaMassQuery,
} from '@qiwu/shared'
import { In, type SelectQueryBuilder } from 'typeorm'
import { BaseCrudService } from '../../../../core/db/base-crud.service.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { ValidationException } from '../../../../core/http/validation.pipe.js'
import { WxoaDraft, WxoaFan, WxoaMassJob, WxoaMessage, WxoaTag } from '../core/wxoa.entity.js'
import { WxoaGateway, type WxoaCaller } from '../core/wxoa-gateway.js'
import { WxoaInboundHub, type WxoaInbound } from '../core/wxoa-inbound-hub.js'
import {
  draftDigest,
  jsonObject,
  stringId,
  textOf,
  upstreamErrcode,
  activeAccount,
  wxNumber,
} from '../core/wxoa-util.js'

/** 群发接口的去向：按 openid 列表走 send，全部粉丝或标签走 sendall，预览走 preview。 */
type MassRoute = 'send' | 'sendall' | 'preview'

/** 微信已收下同一 clientmsgid 的群发（24 小时内防重）：说明上一次提交其实成功了。 */
const CLIENT_MSG_ID_EXISTS = 45065

@Injectable()
export class WxoaMassService extends BaseCrudService<WxoaMassJob> implements OnModuleInit {
  constructor(
    txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly gateway: WxoaGateway,
    private readonly hub: WxoaInboundHub,
  ) {
    super(txHost, WxoaMassJob)
  }
  onModuleInit() {
    this.hub.on((row) => this.receipt(row))
  }
  /** 列表只含所查账号的行（同租户的其它账号不混入）。 */
  protected override filter(
    qb: SelectQueryBuilder<WxoaMassJob>,
    q: WxoaMassQuery,
  ): SelectQueryBuilder<WxoaMassJob> {
    qb.andWhere('t.accountId = :accountId', { accountId: q.accountId })
    return qb
  }
  /** 群发记录分页，先确认账号属于当前租户且可用。 */
  async list(q: WxoaMassQuery) {
    await activeAccount(this.txHost, q.accountId)
    return this.page(q)
  }
  /** 群发详情：已拿到 msg_id 的再用 mass/get 查一次发送状态，只回传状态字段。 */
  async one(id: number) {
    const row = await this.get(id)
    if (!row.wxMsgId) return row
    const answer = await this.gateway.json(
      await activeAccount(this.txHost, row.accountId),
      '/cgi-bin/message/mass/get',
      { body: { msg_id: row.wxMsgId } },
    )
    return {
      ...row,
      upstream: { msgId: textOf(answer.msg_id), msgStatus: textOf(answer.msg_status) },
    }
  }
  /**
   * 新建群发任务并提交：对象与草稿先按本账号校验，任务行在事务里建好并取得 `qw-<id>` 作为
   * clientmsgid，再调用微信；结果未知时任务留在 submitted，可用 {@link retry} 以同一 clientmsgid 重发。
   */
  async send(dto: WxoaMassCreate, _operatorId: number) {
    const account = await activeAccount(this.txHost, dto.accountId)
    if (dto.targetKind === 'tag') {
      const tag = await this.txHost.tx
        .getRepository(WxoaTag)
        .findOne({ where: { accountId: account.id, tagId: dto.tagId } })
      if (!tag) throw new NotFoundException()
    }
    // 去重后的列表既用于校验归属，也是保存并发给微信的列表：重复的 openid 不会让同一粉丝收到两次
    const openIds = dto.targetKind === 'openids' ? [...new Set(dto.openIds ?? [])] : null
    if (openIds) {
      if (openIds.length < 2) throw invalid(['openIds'], 'validation.invalid')
      const count = await this.txHost.tx
        .getRepository(WxoaFan)
        .count({ where: { accountId: account.id, openId: In(openIds) } })
      if (count !== openIds.length) throw new NotFoundException()
    }
    const payload = await this.withDraft(account.id, dto)
    // 只保存白名单字段：重试时按同一份内容重建请求
    const stored = {
      ...messageFields(dto.msgKind, payload),
      ...(dto.sendIgnoreReprint ? { ignoreReprint: true } : {}),
    }
    const row = await this.txHost.withTransaction(async () => {
      // 先用随机占位插入，再改成 qw-<id>：并发创建不会撞上 (account_id, client_msg_id) 唯一键
      const created = await this.create({
        accountId: account.id,
        targetKind: dto.targetKind,
        tagId: dto.tagId ?? null,
        openIds,
        msgKind: dto.msgKind,
        payload: stored,
        clientMsgId: `qw-tmp-${randomBytes(8).toString('hex')}`,
        wxMsgId: null,
        msgDataId: null,
        jobState: 'submitted',
        result: null,
        finishedAt: null,
      })
      await this.update(created.id, { clientMsgId: `qw-${created.id}` })
      return this.get(created.id)
    })
    return this.submit(account, row)
  }
  /**
   * 重发结果未知的任务（例如网关超时 B6001）：沿用原 clientmsgid，微信 24 小时内按它防重，
   * 不会产生第二次群发。已拿到 msg_id 或已结束的任务回 409；创建超过 23 小时的任务回 409 B6103：
   * 微信的防重窗口只有 24 小时，过了窗口再用同一 clientmsgid 提交可能真的再群发一次。
   */
  async retry(id: number) {
    const row = await this.get(id)
    if (row.jobState !== 'submitted' || row.wxMsgId) throw new ConflictException()
    if (Date.now() - row.createdAt.getTime() > WXOA_MASS_RETRY_MS)
      throw new BizError(Err.WXOA_MASS_RETRY_EXPIRED)
    return this.submit(await activeAccount(this.txHost, row.accountId), row)
  }
  /** 预览只允许发给本账号粉丝，并把微信成功结果写入预览消息日志。 */
  async preview(dto: WxoaMassPreview, operatorId: number) {
    const account = await activeAccount(this.txHost, dto.accountId)
    const fan = await this.txHost.tx.getRepository(WxoaFan).findOne({
      where: { accountId: account.id, openId: dto.toOpenId },
    })
    if (!fan) throw new NotFoundException()
    const fields = messageFields(dto.msgKind, await this.withDraft(account.id, dto))
    const body = { touser: dto.toOpenId, ...messageBody(dto.msgKind, fields, 'preview') }
    await this.gateway.json(account, '/cgi-bin/message/mass/preview', { body })
    await this.txHost.tx.getRepository(WxoaMessage).save({
      accountId: account.id,
      openId: dto.toOpenId,
      direction: 'out',
      channel: 'preview',
      msgKind: dto.msgKind,
      eventKind: null,
      eventKey: null,
      payload: fields,
      objectId: null,
      wxMsgId: null,
      dedupKey: null,
      sendState: 'sent',
      errcode: 0,
      operatorId,
      occurredAt: new Date(),
    })
    return { channel: 'preview' }
  }
  /** 删除已群发的内容；`index` 只删其中一篇（从 1 开始），不填删除全部并把任务标为 removed。 */
  async drop(id: number, index?: number) {
    const row = await this.get(id)
    if (row.wxMsgId)
      await this.gateway.json(
        await activeAccount(this.txHost, row.accountId),
        '/cgi-bin/message/mass/delete',
        { body: { msg_id: wxNumber(row.wxMsgId), article_idx: index ?? 0 } },
      )
    if (index === undefined) await this.update(id, { jobState: 'removed', finishedAt: new Date() })
  }

  /** mpnews 的 media_id 取自本账号已同步且无未同步修改的草稿（否则 404 / 409 B6101）。 */
  private async withDraft(accountId: number, dto: WxoaMassCreate) {
    const payload: Record<string, unknown> = { ...dto.payload }
    if (dto.msgKind !== 'mpnews') return payload
    if (!dto.draftId) throw new BizError(Err.WXOA_DRAFT_UNSYNCED)
    const draft = await this.txHost.tx
      .getRepository(WxoaDraft)
      .findOne({ where: { id: dto.draftId, accountId } })
    if (!draft) throw new NotFoundException()
    if (!draft.mediaId || draft.syncedDigest !== draftDigest(draft.articles))
      throw new BizError(Err.WXOA_DRAFT_UNSYNCED)
    payload.media_id = draft.mediaId
    return payload
  }

  /**
   * 调用群发接口并记下结果：成功写 msg_id（图文另清掉草稿的 media_id）；微信明确拒绝（有 errcode）标为 failed；
   * 45065 表示同一 clientmsgid 早已被收下，任务保持 submitted；网络错误、超时等结果未知的
   * 情况任务保持 submitted 不动，错误原样抛出，由调用方决定是否重试。
   */
  private async submit(account: WxoaCaller, row: WxoaMassJob) {
    const route: MassRoute = row.targetKind === 'openids' ? 'send' : 'sendall'
    const target =
      row.targetKind === 'all'
        ? { filter: { is_to_all: true } }
        : row.targetKind === 'tag'
          ? { filter: { is_to_all: false, tag_id: row.tagId } }
          : { touser: row.openIds }
    const body = {
      ...target,
      ...messageBody(row.msgKind, row.payload, route),
      clientmsgid: row.clientMsgId,
      send_ignore_reprint: row.payload.ignoreReprint === true ? 1 : 0,
    }
    try {
      const answer = await this.gateway.json(account, `/cgi-bin/message/mass/${route}`, { body })
      await this.update(row.id, {
        wxMsgId: stringId(answer.msg_id),
        msgDataId: stringId(answer.msg_data_id),
      })
      // 图文群发成功后微信作废该草稿的 media_id：本地草稿去掉它并标为未同步，再用须重新同步
      if (row.msgKind === 'mpnews' && typeof row.payload.media_id === 'string')
        await this.txHost.tx
          .getRepository(WxoaDraft)
          .update(
            { accountId: row.accountId, mediaId: row.payload.media_id },
            { mediaId: null, syncedDigest: null },
          )
    } catch (err) {
      const errcode = upstreamErrcode(err)
      if (errcode === CLIENT_MSG_ID_EXISTS) return this.get(row.id)
      if (errcode === null) throw err
      await this.update(row.id, { jobState: 'failed', result: { errcode }, finishedAt: new Date() })
      throw err
    }
    return this.get(row.id)
  }

  /** MASSSENDJOBFINISH 回执：按 MsgID 找到任务，写入状态与白名单内的计数字段。 */
  private async receipt(row: WxoaInbound) {
    if (row.eventKind !== 'MASSSENDJOBFINISH') return
    const wxMsgId = textOf(row.payload.MsgID) || row.wxMsgId || ''
    if (!wxMsgId) return
    const item = await this.repo.findOne({ where: { accountId: row.accountId, wxMsgId } })
    if (!item) return
    const status = textOf(row.payload.Status)
    const count = (v: unknown) => (textOf(v) === '' ? null : Number(textOf(v)))
    const copyright = jsonObject(row.payload.CopyrightCheckResult)
    await this.update(item.id, {
      // 官方取值为 "send success" / "send fail" / "err(num)"
      jobState: /success/i.test(status) && !/fail|err/i.test(status) ? 'succeeded' : 'failed',
      result: {
        status,
        totalCount: count(row.payload.TotalCount),
        filterCount: count(row.payload.FilterCount),
        sentCount: count(row.payload.SentCount),
        errorCount: count(row.payload.ErrorCount),
        checkState: count(copyright.CheckState),
      } as never,
      finishedAt: new Date(),
    })
  }
}

/** 群发请求的 400：字段路径与校验消息键，字段名按 `wxoa.mass` 域翻译。 */
function invalid(path: string[], message: string): ValidationException {
  const e = new ValidationException([{ code: 'custom', path, message, input: undefined }])
  e.domain = 'wxoa.mass'
  return e
}

/**
 * 群发内容的白名单字段：text 取 content，其余取 media_id（视频另有可选 title/description）。
 * 缺字段回 400，任何别的键都不会进入发给微信的请求。
 */
function messageFields(kind: string, payload: Record<string, unknown>): Record<string, string> {
  const need = kind === 'text' ? 'content' : 'media_id'
  const value = typeof payload[need] === 'string' ? (payload[need] as string).trim() : ''
  if (!value) throw invalid(['payload', need], 'validation.required')
  const out: Record<string, string> = { [need]: value }
  if (kind === 'video')
    for (const key of ['title', 'description'])
      if (typeof payload[key] === 'string' && payload[key]) out[key] = payload[key] as string
  return out
}

/**
 * 按官方格式组装消息部分（都带必填的 msgtype）：群发图片用 images.media_ids、预览用 image.media_id；
 * 视频统一是 mpvideo，只有按 openid 群发带标题与描述。
 */
function messageBody(kind: string, fields: Record<string, unknown>, route: MassRoute) {
  const id = textOf(fields.media_id)
  switch (kind) {
    case 'text':
      return { msgtype: 'text', text: { content: textOf(fields.content) } }
    case 'image':
      return route === 'preview'
        ? { msgtype: 'image', image: { media_id: id } }
        : { msgtype: 'image', images: { media_ids: [id] } }
    case 'video': {
      const extra =
        route === 'send'
          ? Object.fromEntries(
              ['title', 'description'].filter((k) => textOf(fields[k])).map((k) => [k, fields[k]]),
            )
          : {}
      return { msgtype: 'mpvideo', mpvideo: { media_id: id, ...extra } }
    }
    default:
      return { msgtype: kind, [kind]: { media_id: id } }
  }
}
