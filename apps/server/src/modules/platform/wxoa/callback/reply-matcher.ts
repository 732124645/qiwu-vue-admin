import { Injectable } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { type WxoaReplyTrigger, wxoaReplyBodies } from '@qiwu/shared'
import { WxoaMaterial, WxoaReplyRule } from '../core/wxoa.entity.js'
import type { WxoaPush, WxoaReply } from '../core/wxoa-xml.js'

/** How a text and a keyword are compared: NFC, outer white space trimmed, Latin letters lower case. */
export const wxoaFold = (s: string) =>
  s
    .normalize('NFC')
    .trim()
    .replace(/\p{Script=Latin}+/gu, (m) => m.toLowerCase())

/** exact before contains within one priority */
const rank = (r: WxoaReplyRule) => (r.matchMode === 'exact' ? 0 : 1)

/**
 * The automatic reply to a push (see docs/design-notes.md#wxoa), read from the rule table on every push
 * (no cache: a changed rule applies at once). `subscribe` with a `qrscene_` key tries the scan rule of
 * that scene first, then the subscribe rule; `SCAN` the scan rule of its scene; `CLICK` the click rule
 * of its key (compared as is); a text, or a voice message's recognition, the keyword rules (priority
 * high first, exact before contains, then id); a user message nothing matched the default rule. Only
 * enabled rules of the account count; events never get the default rule.
 */
@Injectable()
export class WxoaReplyMatcher {
  constructor(private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>) {}

  async match(accountId: number, push: WxoaPush): Promise<WxoaReplyRule | null> {
    if (!push.known) return null
    const rules = this.txHost.tx.getRepository(WxoaReplyRule)
    const one = (triggerKind: WxoaReplyTrigger, eventKey?: string) =>
      rules.findOne({
        where: { accountId, triggerKind, enabled: true, ...(eventKey ? { eventKey } : {}) },
        order: { id: 'ASC' },
      })
    const key = push.eventKey ?? ''
    if (push.msgKind === 'event')
      switch (push.eventKind) {
        case 'subscribe': {
          const scene = key.startsWith('qrscene_') ? key.slice('qrscene_'.length) : ''
          return (scene && (await one('scan', scene))) || one('subscribe')
        }
        case 'SCAN':
          return key ? one('scan', key) : null
        case 'CLICK':
          return key ? one('click', key) : null
        default:
          return null
      }
    // every other kind with its own structure is a user message
    if (push.text !== null) {
      const said = wxoaFold(push.text)
      const keywords = await rules.find({
        where: { accountId, triggerKind: 'keyword', enabled: true },
        order: { priority: 'DESC', id: 'ASC' },
      })
      keywords.sort((a, b) => b.priority - a.priority || rank(a) - rank(b) || a.id - b.id)
      const hit = keywords.find((r) =>
        (r.keywords ?? []).some((w) =>
          r.matchMode === 'exact' ? said === wxoaFold(w) : said.includes(wxoaFold(w)),
        ),
      )
      if (hit) return hit
    }
    return one('default')
  }

  /**
   * What `rule` replies, its media the account's live material; null when the body no longer passes its
   * schema or the material is gone.
   */
  async reply(rule: WxoaReplyRule): Promise<WxoaReply | null> {
    const parsed = wxoaReplyBodies[rule.replyKind]?.safeParse(rule.replyBody)
    if (!parsed?.success) return null
    const body = parsed.data as Record<string, string | undefined>
    const text = (k: string) => body[k] ?? ''
    if (rule.replyKind === 'text') return { kind: 'text', content: text('content') }
    if (rule.replyKind === 'news')
      return {
        kind: 'news',
        title: text('title'),
        description: text('description'),
        url: text('url'),
        picUrl: text('picUrl'),
      }
    const material = rule.materialId
      ? await this.txHost.tx
          .getRepository(WxoaMaterial)
          .findOneBy({ id: rule.materialId, accountId: rule.accountId })
      : null
    if (!material) return null
    const mediaId = material.mediaId
    switch (rule.replyKind) {
      case 'image':
      case 'voice':
        return { kind: rule.replyKind, mediaId }
      case 'video':
        return { kind: 'video', mediaId, title: body.title, description: body.description }
      case 'music':
        return {
          kind: 'music',
          title: text('title'),
          description: text('description'),
          musicUrl: text('musicUrl'),
          hqMusicUrl: body.hqMusicUrl,
          thumbMediaId: mediaId,
        }
      default:
        return null
    }
  }
}
