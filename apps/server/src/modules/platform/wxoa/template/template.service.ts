import { Inject, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  Err,
  fieldDomains,
  type WxoaIndustryVo,
  type WxoaTemplateSendBody,
  type WxoaTemplateVo,
} from '@qiwu/shared'
import { In } from 'typeorm'
import { z } from 'zod'
import { BizError } from '../../../../core/http/biz-error.js'
import { parseOr400 } from '../../../../core/http/validation.pipe.js'
import { redisKey } from '../../../../core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../../../core/redis/redis.module.js'
import { WxoaAccount, WxoaFan, WxoaMessage } from '../core/wxoa.entity.js'
import { type WxoaCaller, type WxoaJson, WxoaGateway } from '../core/wxoa-gateway.js'
import { type WxoaInbound, WxoaInboundHub } from '../core/wxoa-inbound-hub.js'

const SEND = '/cgi-bin/message/template/send'
/** seconds an account's template list is reused */
const LIST_TTL = 600
/** a data key of the template text: `{{thing3.DATA}}` */
const PLACEHOLDER = /\{\{\s*([A-Za-z_]\w*)\.DATA\s*\}\}/g
/** a msgid as WeChat answers it (64-bit, kept as its digits) */
const MSG_ID = /^\d{1,24}$/

const text = (v: unknown) => (typeof v === 'string' ? v : '')

/** `get_all_private_template`'s list, the entries without a template id left out. */
function templatesOf(answer: WxoaJson): WxoaTemplateVo[] {
  const list = Array.isArray(answer.template_list) ? (answer.template_list as WxoaJson[]) : []
  return list.flatMap((t) =>
    t && typeof t.template_id === 'string' && t.template_id
      ? [
          {
            templateId: t.template_id,
            title: text(t.title),
            primaryIndustry: text(t.primary_industry),
            deputyIndustry: text(t.deputy_industry),
            content: text(t.content),
            example: text(t.example),
          },
        ]
      : [],
  )
}

const industryOf = (raw: unknown) =>
  raw && typeof raw === 'object'
    ? { first: text((raw as WxoaJson).first_class), second: text((raw as WxoaJson).second_class) }
    : null

/** A receipt's `Status` as the row's send state; an unknown one leaves the row as it is. */
function receiptState(status: unknown): 'delivered' | 'user_blocked' | 'failed' | null {
  if (typeof status !== 'string') return null
  if (status === 'success') return 'delivered'
  if (/user\s*block/i.test(status)) return 'user_blocked'
  return status.startsWith('failed') ? 'failed' : null
}

/**
 * Template messages (see docs/design-notes.md#wxoa). Templates are WeChat's, never stored: the list is
 * cached 10 minutes per account (a delete drops it). A send checks the data keys against the template,
 * writes one pending outbound row per fan and returns them; the messages go out one by one after that
 * (`client_msg_id` `qw-<row id>`, which WeChat dedupes for 10 minutes), each row recording its msgid or
 * errcode. `TEMPLATESENDJOBFINISH` receipts settle the rows. Every route goes through the account:
 * alive (404) and enabled (`B6011`).
 */
@Injectable()
export class WxoaTemplateService implements OnModuleInit {
  private readonly logger = new Logger(WxoaTemplateService.name)

  constructor(
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly gateway: WxoaGateway,
    private readonly hub: WxoaInboundHub,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    this.hub.on((row) => this.receipt(row))
  }

  /** The account's templates: from the cache unless `refresh`, else from WeChat (cached again). */
  async list(accountId: number, refresh = false): Promise<WxoaTemplateVo[]> {
    return this.templates(await this.account(accountId), refresh)
  }

  async industry(accountId: number): Promise<WxoaIndustryVo> {
    const answer = await this.gateway.json(
      await this.account(accountId),
      '/cgi-bin/template/get_industry',
    )
    return {
      primary: industryOf(answer.primary_industry),
      secondary: industryOf(answer.secondary_industry),
    }
  }

  /** Deletes template `templateId` (one of the account's, else 404) on WeChat; the cached list goes. */
  async drop(accountId: number, templateId: string): Promise<void> {
    const account = await this.account(accountId)
    await this.template(account, templateId)
    await this.gateway.json(account, '/cgi-bin/template/del_private_template', {
      body: { template_id: templateId },
    })
    await this.redis.unlink(this.listKey(account.id))
  }

  /**
   * Writes a pending template row for each fan (fans of the account, else 404) and sends them after
   * this returns. Data keys the template does not have → 400.
   */
  async send(
    templateId: string,
    dto: WxoaTemplateSendBody,
    operatorId: number,
  ): Promise<WxoaMessage[]> {
    const account = await this.account(dto.accountId)
    const fanIds = [...new Set(dto.fanIds)]
    const fans = await this.txHost.tx.getRepository(WxoaFan).find({
      select: { id: true, openId: true },
      where: { id: In(fanIds), accountId: account.id },
      order: { id: 'ASC' },
    })
    if (fans.length !== fanIds.length) throw new NotFoundException()
    const template = await this.template(account, templateId)
    const keys = new Set([...template.content.matchAll(PLACEHOLDER)].map((m) => m[1]!))
    parseOr400(
      z
        .object({
          data: z.record(z.string(), z.string()).superRefine((data, ctx) => {
            for (const key of Object.keys(data))
              if (!keys.has(key))
                ctx.addIssue({ code: 'custom', path: [key], message: 'validation.invalid' })
          }),
        })
        .register(fieldDomains, { domain: 'wxoa.template' }),
      { data: dto.data },
    )
    const payload = {
      templateId,
      title: template.title,
      data: dto.data,
      url: dto.url ?? null,
      miniprogram: dto.miniprogram ?? null,
    }
    const repo = this.txHost.tx.getRepository(WxoaMessage)
    const occurredAt = new Date()
    const rows = await repo.save(
      fans.map((fan) =>
        repo.create({
          accountId: account.id,
          openId: fan.openId,
          direction: 'out',
          channel: 'template',
          msgKind: 'template',
          payload,
          sendState: 'pending',
          operatorId,
          occurredAt,
        }),
      ),
    )
    void this.deliver(account, dto, templateId, rows).catch((err: unknown) =>
      this.logger.warn({ accountId: account.id, err }, 'wxoa template send: rows not settled'),
    )
    return rows
  }

  /** Sends the pending rows one by one; a row the purge already failed stays as it is. */
  private async deliver(
    account: WxoaCaller,
    dto: WxoaTemplateSendBody,
    templateId: string,
    rows: WxoaMessage[],
  ): Promise<void> {
    const repo = this.txHost.tx.getRepository(WxoaMessage)
    const data = Object.fromEntries(Object.entries(dto.data).map(([k, value]) => [k, { value }]))
    for (const row of rows) {
      let settled: Pick<WxoaMessage, 'sendState' | 'errcode'> & { wxMsgId?: string | null }
      try {
        const answer = await this.gateway.json(account, SEND, {
          body: {
            touser: row.openId,
            template_id: templateId,
            ...(dto.url ? { url: dto.url } : {}),
            ...(dto.miniprogram
              ? {
                  miniprogram: { appid: dto.miniprogram.appId, pagepath: dto.miniprogram.pagePath },
                }
              : {}),
            client_msg_id: `qw-${row.id}`,
            data,
          },
        })
        const msgId = String(answer.msgid ?? '')
        settled = { sendState: 'sent', errcode: 0, wxMsgId: MSG_ID.test(msgId) ? msgId : null }
      } catch (err) {
        const errcode = err instanceof BizError ? err.params.errcode : undefined
        settled = { sendState: 'failed', errcode: typeof errcode === 'number' ? errcode : null }
      }
      await repo.update({ id: row.id, sendState: 'pending' }, settled)
    }
  }

  /** A `TEMPLATESENDJOBFINISH` receipt settles the sent row of that fan and msgid. */
  private async receipt(row: WxoaInbound): Promise<void> {
    if (row.msgKind !== 'event' || row.eventKind !== 'TEMPLATESENDJOBFINISH' || !row.wxMsgId) return
    const sendState = receiptState(row.payload.Status)
    if (!sendState) return
    await this.txHost.tx.getRepository(WxoaMessage).update(
      {
        accountId: row.accountId,
        wxMsgId: row.wxMsgId,
        openId: row.openId,
        direction: 'out',
        channel: 'template',
        sendState: 'sent',
      },
      { sendState },
    )
  }

  /** Template `templateId` of the account's (cached) list; else 404. */
  private async template(account: WxoaCaller, templateId: string): Promise<WxoaTemplateVo> {
    const found = (await this.templates(account)).find((t) => t.templateId === templateId)
    if (!found) throw new NotFoundException()
    return found
  }

  private async templates(account: WxoaCaller, refresh = false): Promise<WxoaTemplateVo[]> {
    const key = this.listKey(account.id)
    const cached = refresh ? null : await this.redis.get(key)
    if (cached) return JSON.parse(cached) as WxoaTemplateVo[]
    const list = templatesOf(
      await this.gateway.json(account, '/cgi-bin/template/get_all_private_template'),
    )
    await this.redis.set(key, JSON.stringify(list), {
      expiration: { type: 'EX', value: LIST_TTL },
    })
    return list
  }

  /** Account `id`, alive (else 404) and enabled (else `B6011`). */
  private async account(id: number): Promise<WxoaCaller> {
    const row = await this.txHost.tx.getRepository(WxoaAccount).findOne({
      select: { id: true, appId: true, accountKind: true, enabled: true },
      where: { id },
    })
    if (!row) throw new NotFoundException()
    if (!row.enabled) throw new BizError(Err.WXOA_ACCOUNT_DISABLED)
    return { id: row.id, appId: row.appId, accountKind: row.accountKind }
  }

  private listKey = (accountId: number) => redisKey('wxoa', 'tpl', accountId)
}
