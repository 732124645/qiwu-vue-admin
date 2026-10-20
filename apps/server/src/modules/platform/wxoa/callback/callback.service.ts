import { createHash } from 'node:crypto'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { QueryFailedError } from 'typeorm'
import { AppConfigService } from '../../../../core/config/config.module.js'
import { SecretBox } from '../../../../core/crypto/secret-box.js'
import { allTenants, withTenant } from '../../../../core/context/tenant.js'
import { redisKey } from '../../../../core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../../../core/redis/redis.module.js'
import { WxoaAccount, WxoaMessage, type WxoaReplyRule } from '../core/wxoa.entity.js'
import {
  type WxoaCipher,
  wxoaAesKey,
  wxoaDecrypt,
  wxoaSealReply,
  wxoaSignOk,
  wxoaTimeOk,
} from '../core/wxoa-crypto.js'
import { type WxoaInbound, WxoaInboundHub } from '../core/wxoa-inbound-hub.js'
import {
  type WxoaPush,
  WXOA_NOTICE_EVENTS,
  wxoaEncryptOf,
  wxoaParseXml,
  wxoaReadPush,
  wxoaReplyXml,
  WxoaXmlError,
} from '../core/wxoa-xml.js'
import { wxoaTenantServes } from '../core/wxoa-util.js'
import { WxoaReplyMatcher } from './reply-matcher.js'

/** A callback key: 16 random bytes, base64url. */
const KEY = /^[A-Za-z0-9_-]{22}$/
/** Failures one IP may have per account (or for unknown keys) within the window before 429. */
export const WXOA_CALLBACK_FAIL_MAX = 120
const FAIL_WINDOW_S = 60
/** A plain push's nonce binding: twice the timestamp window, so it outlives every timestamp accepted. */
export const WXOA_NONCE_TTL_S = 600
/** Largest push body, in bytes. */
export const WXOA_PUSH_MAX_BYTES = 64 * 1024
/** `last_push_at` is rewritten only when it is older than this. */
const STAMP_MS = 60_000
/** Past this the push is answered `success` and its handling goes on. */
const BUDGET_MS = 4_000
const NONCE = /^[\x21-\x7e]{1,64}$/
const ECHO_MAX = 128
/** what a GET or a sealed push leaves on the nonce key: never a body's digest */
const TAKEN = 'taken'

/** The user messages (`MsgType`): they write the fan row and may get the default reply. */
const USER_MESSAGES: ReadonlySet<string> = new Set([
  'text',
  'image',
  'voice',
  'video',
  'shortvideo',
  'location',
  'link',
])
/** Events from a user, which write the fan row besides the message (receipts and the like do not). */
const FAN_EVENTS: ReadonlySet<string> = new Set([
  'subscribe',
  'unsubscribe',
  'SCAN',
  'CLICK',
  'VIEW',
  'view_miniprogram',
  'scancode_push',
  'scancode_waitmsg',
  'pic_sysphoto',
  'pic_photo_or_album',
  'pic_weixin',
  'location_select',
])
/** Events opening the one-minute customer-service window (`last_event_at`); VIEW does not. */
const WINDOW_EVENTS: ReadonlySet<string> = new Set([
  'subscribe',
  'SCAN',
  'CLICK',
  'scancode_push',
  'scancode_waitmsg',
])

/** The account as the callback reads it: deleted and disabled rows too, the Token and AES key boxed. */
type CallbackAccount = Pick<
  WxoaAccount,
  | 'id'
  | 'appId'
  | 'enabled'
  | 'tenantId'
  | 'deletedAt'
  | 'cryptoMode'
  | 'pushTokenEnc'
  | 'aesKeyEnc'
  | 'lastPushAt'
>

/** A request let through the failure count: its account (null for an unknown key) and counter. */
interface Gate {
  account: CallbackAccount | null
  failKey: string
}

/** The query of a push. */
export type WxoaPushQuery = Record<string, unknown>

/** What the controller writes: a status, a text or XML body, and work to start once it is written. */
export interface WxoaAnswer {
  status: number
  body?: string
  xml?: boolean
  after?: () => void
}

/** The request body as the controller reads it: null once it passed the limit, 'consumed' when gone. */
export type WxoaBody = Buffer | null | 'consumed'

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
const SUCCESS: WxoaAnswer = { status: 200, body: 'success' }

/**
 * The push callback `/api/wxoa/callback/:key` (see docs/design-notes.md#wxoa). Every request of a
 * well-formed key is counted when it fails (unknown key, disabled or deleted account, timestamp out of
 * the window, bad signature, a seen plain nonce with another body, an undecryptable message, and a 400 /
 * 413 before the signature is known): per source IP and account, per IP alone for unknown keys; past the
 * limit that IP gets 429 for that account only. Signed pushes are never counted. GET checks `signature`
 * in every mode; POST checks `signature` in plain mode and binds the body to its nonce, `msg_signature`
 * over the required `Encrypt` in compat and secure mode; a signed GET or sealed push holds its nonce, so
 * its query cannot come back as a plain push. A push is stored once (the database's unique
 * key), with its fan row in the same transaction, answered by a rule or `success`, and handed to the
 * inbound hub after the answer; nothing on that path calls WeChat.
 */
@Injectable()
export class WxoaCallbackService {
  private readonly logger = new Logger(WxoaCallbackService.name)

  constructor(
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly box: SecretBox,
    private readonly matcher: WxoaReplyMatcher,
    private readonly hub: WxoaInboundHub,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly cfg: AppConfigService,
  ) {}

  /** GET: WeChat checking the URL. The echo comes back as it was once `signature` holds. */
  async verify(key: string, ip: string, q: WxoaPushQuery): Promise<WxoaAnswer> {
    const gate = await this.open(key, ip)
    if ('status' in gate) return gate
    // qw:cross-tenant callback key lookup resolves the account tenant before verification work begins
    return withTenant(gate.account?.tenantId ?? 1, () => this.verifyOpen(gate, q))
  }

  private async verifyOpen(gate: Gate, q: WxoaPushQuery): Promise<WxoaAnswer> {
    const token = gate.account && this.token(gate.account)
    const echo = q.echostr
    if (
      !token ||
      typeof echo !== 'string' ||
      !echo ||
      echo.length > ECHO_MAX ||
      !this.signed(q.signature, token, q)
    )
      return this.fail(gate)
    await this.takeNonce(gate.account!, q)
    return { status: 200, body: echo }
  }

  /** POST: a push. `read` gives the body (at most {@link WXOA_PUSH_MAX_BYTES}). */
  async receive(
    key: string,
    ip: string,
    q: WxoaPushQuery,
    read: () => Promise<WxoaBody>,
  ): Promise<WxoaAnswer> {
    const gate = await this.open(key, ip)
    if ('status' in gate) return gate
    // qw:cross-tenant callback key lookup resolves the account tenant before receive work begins
    return withTenant(gate.account?.tenantId ?? 1, () => this.receiveOpen(gate, q, read))
  }

  private async receiveOpen(
    gate: Gate,
    q: WxoaPushQuery,
    read: () => Promise<WxoaBody>,
  ): Promise<WxoaAnswer> {
    const body = await read()
    if (body === 'consumed') return this.fail(gate, 400)
    if (body === null) return this.fail(gate, 413)
    const account = gate.account
    const token = account && this.token(account)
    if (!account || !token) return this.fail(gate)
    let fields: Record<string, unknown>
    let cipher: WxoaCipher | null = null
    const text = body.toString('utf8')
    if (account.cryptoMode === 'plain') {
      if (!this.signed(q.signature, token, q)) return this.fail(gate)
      const digest = sha256(body)
      const seen = await this.redis.set(this.nonceKey(account, q), digest, {
        condition: 'NX',
        GET: true,
        expiration: { type: 'EX', value: WXOA_NONCE_TTL_S },
      })
      if (seen !== null && seen !== digest) return this.fail(gate)
      await this.stamp(account)
      const parsed = parse(() => wxoaParseXml(text))
      if (!parsed) return { status: 400 }
      fields = parsed
    } else {
      const outer = parse(() => wxoaParseXml(text))
      const encrypt = outer && parse(() => wxoaEncryptOf(outer))
      if (!outer || encrypt === undefined) return this.fail(gate, 400)
      const aesKey = this.aesKey(account)
      if (
        q.encrypt_type !== 'aes' ||
        !encrypt ||
        !aesKey ||
        !this.signed(q.msg_signature, token, q, encrypt)
      )
        return this.fail(gate)
      await this.takeNonce(account, q)
      let inner: string
      try {
        inner = wxoaDecrypt(aesKey, encrypt, account.appId)
      } catch {
        return this.fail(gate)
      }
      cipher = { token, key: aesKey, appId: account.appId }
      await this.stamp(account)
      const parsed = parse(() => wxoaParseXml(inner))
      if (!parsed) return { status: 400 }
      fields = parsed
    }
    const push = parse(() => wxoaReadPush(fields))
    if (!push) return { status: 400 }
    return this.answer(account.id, account.tenantId, push, cipher, q.nonce as string)
  }

  /** The account of `key` (deleted and disabled ones too), with its boxed Token and AES key. */
  findAccount(key: string): Promise<CallbackAccount | null> {
    // qw:cross-tenant callback key lookup resolves the account before entering its tenant context
    return allTenants(() =>
      this.txHost.tx
        .getRepository(WxoaAccount)
        .createQueryBuilder('a')
        .withDeleted()
        .addSelect(['a.pushTokenEnc', 'a.aesKeyEnc'])
        .where('a.callbackKey = :key', { key })
        .orderBy('a.id', 'DESC')
        .getOne(),
    )
  }

  /**
   * A malformed key is 404 without a lookup or a count; an IP past the limit for it is 429. 账号所属租户
   * 不可用（`wxoaTenantServes`）时按未知 key 处理：停用、到期或套餐不含公众号的租户不再落库和自动回复。
   */
  private async open(key: string, ip: string): Promise<Gate | WxoaAnswer> {
    if (!KEY.test(key)) return { status: 404 }
    const found = await this.findAccount(key)
    const account =
      found &&
      (await wxoaTenantServes(this.txHost.tx, this.cfg.get('APP_MULTI_TENANT'), found.tenantId))
        ? found
        : null
    const failKey = account
      ? redisKey('wxoa', 'cb-fail', ip, account.id)
      : redisKey('wxoa', 'cb-fail', ip)
    if (Number(await this.redis.get(failKey)) > WXOA_CALLBACK_FAIL_MAX) return { status: 429 }
    return { account, failKey }
  }

  /** Counts a failure of the gate's IP (and account); the answer is `status`, 404 unless given. */
  private async fail(gate: Gate, status = 404): Promise<WxoaAnswer> {
    await this.redis.multi().incr(gate.failKey).expire(gate.failKey, FAIL_WINDOW_S, 'NX').exec()
    return { status }
  }

  /** The push Token of a live, enabled account; null otherwise or when it cannot be read. */
  private token(account: CallbackAccount): string | null {
    if (!account.enabled || account.deletedAt) return null
    try {
      return this.box.decrypt(account.pushTokenEnc)
    } catch {
      return null
    }
  }

  private aesKey(account: CallbackAccount): Buffer | null {
    try {
      return account.aesKeyEnc ? wxoaAesKey(this.box.decrypt(account.aesKeyEnc)) : null
    } catch {
      return null
    }
  }

  /** The timestamp within the window, a well-formed nonce, and `given` the signature over them. */
  private signed(given: unknown, token: string, q: WxoaPushQuery, ...more: string[]): boolean {
    const { timestamp, nonce } = q
    return (
      wxoaTimeOk(timestamp) &&
      typeof nonce === 'string' &&
      NONCE.test(nonce) &&
      wxoaSignOk(given, token, timestamp as string, nonce, ...more)
    )
  }

  private nonceKey(account: CallbackAccount, q: WxoaPushQuery): string {
    return redisKey('wxoa', 'nonce', account.id, q.timestamp as string, q.nonce as string)
  }

  /**
   * Holds the nonce of a signed GET or sealed push: its query carries `signature`, a plain POST's, so
   * without this the query could be posted with any body (also once the account is switched to plain).
   */
  private async takeNonce(account: CallbackAccount, q: WxoaPushQuery): Promise<void> {
    await this.redis.set(this.nonceKey(account, q), TAKEN, {
      condition: 'NX',
      expiration: { type: 'EX', value: WXOA_NONCE_TTL_S },
    })
  }

  /** Records the signed push on the account, at most once a minute (the row is not a hot spot). */
  private async stamp(account: CallbackAccount): Promise<void> {
    const now = Date.now()
    if (account.lastPushAt && now - account.lastPushAt.getTime() <= STAMP_MS) return
    await this.txHost.tx.query(
      'UPDATE wxoa_account SET last_push_at = ?, updated_at = updated_at WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
      [new Date(now), account.id, account.tenantId],
    )
  }

  /**
   * Stores and answers a signed push within the budget; past it the answer is `success` and the work
   * finishes on its own (no reply is recorded: none went out). Once the answer is written, the reply it
   * carried is recorded (best effort) and the stored row goes to the hub. Compat and secure mode
   * (`cipher`) get the reply encrypted under the push's nonce.
   */
  private async answer(
    accountId: number,
    accountTenantId: number,
    push: WxoaPush,
    cipher: WxoaCipher | null,
    nonce: string,
  ): Promise<WxoaAnswer> {
    const work = this.handle(accountId, accountTenantId, push)
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), BUDGET_MS)
    })
    const done = await Promise.race([work, deadline]).finally(() => clearTimeout(timer))
    if (!done) return { ...SUCCESS, after: () => void this.later(work) }
    const { inbound, reply } = done
    const after = () =>
      // qw:cross-tenant callback row lookup selects the account tenant before after-response work
      void withTenant(accountTenantId, () => this.settle(accountId, push, inbound, reply?.rule))
    if (!reply) return { ...SUCCESS, after }
    const xml = cipher ? wxoaSealReply(cipher, reply.xml, { nonce }) : reply.xml
    return { status: 200, body: xml, xml: true, after }
  }

  /** After the answer: the reply it carried as an outbound row, then the stored row to the hub. */
  private async settle(
    accountId: number,
    push: WxoaPush,
    inbound: WxoaInbound | null,
    rule: WxoaReplyRule | undefined,
  ): Promise<void> {
    if (rule)
      await this.record(accountId, push, rule).catch(() =>
        this.logger.warn('a passive reply could not be recorded'),
      )
    if (inbound) await this.hub.emit(inbound)
  }

  private async later(work: Promise<{ inbound: WxoaInbound | null }>): Promise<void> {
    try {
      const { inbound } = await work
      if (inbound) await this.hub.emit(inbound)
    } catch {
      this.logger.warn('a push handled past the time budget failed')
    }
  }

  /**
   * Writes the push (a duplicate stops here) and its fan row in one transaction, then finds the rule
   * answering it and its reply XML. A location report is neither stored nor answered; a stored push whose
   * rule cannot be read is answered `success` and still goes to the hub.
   */
  private async handle(
    accountId: number,
    accountTenantId: number,
    push: WxoaPush,
  ): Promise<{ inbound: WxoaInbound | null; reply: { rule: WxoaReplyRule; xml: string } | null }> {
    if (push.msgKind === 'event' && push.eventKind === 'LOCATION')
      return { inbound: null, reply: null }
    const now = new Date()
    const inbound = await this.txHost.withTransaction(async () => {
      const row = await this.insertInbound(accountId, accountTenantId, push, now)
      if (row && fanKind(push)) await this.upsertFan(accountId, accountTenantId, push, now)
      return row
    })
    if (!inbound) return { inbound: null, reply: null }
    try {
      const rule = await this.matcher.match(accountId, push)
      const reply = rule && (await this.matcher.reply(rule))
      const xml = reply && wxoaReplyXml(push, reply, now.getTime())
      return { inbound, reply: rule && xml ? { rule, xml } : null }
    } catch (err) {
      this.logger.warn(
        `inbound message ${inbound.id}: its reply rule could not be read: ${(err as Error).message}`,
      )
      return { inbound, reply: null }
    }
  }

  /** The inbound row, or null when its dedup key is taken (WeChat retrying a push already stored). */
  private async insertInbound(
    accountId: number,
    accountTenantId: number,
    push: WxoaPush,
    now: Date,
  ): Promise<WxoaInbound | null> {
    const row = {
      tenantId: accountTenantId,
      accountId,
      openId: push.openId,
      msgKind: push.msgKind,
      eventKind: push.eventKind,
      eventKey: push.eventKey,
      wxMsgId: push.msgId ?? push.msgID,
      payload: push.payload,
      occurredAt: now,
    }
    const repo = this.txHost.tx.getRepository(WxoaMessage)
    try {
      const { id } = await repo.save(
        repo.create({ ...row, direction: 'in', channel: 'push', dedupKey: sha256(dedupOf(push)) }),
      )
      return { id: Number(id), ...row }
    } catch (err) {
      if (err instanceof QueryFailedError && (err.driverError as { errno?: number }).errno === 1062)
        return null
      throw err
    }
  }

  /**
   * The fan row (new rows subscribed unless the event is an unsubscribe): subscribe and unsubscribe set
   * the state and its time (subscribe its QR scene), a user message `last_inbound_at`, the events that
   * open the one-minute window `last_event_at`; the rest only makes sure the row exists.
   */
  async upsertFan(
    accountId: number,
    accountTenantId: number,
    push: WxoaPush,
    now: Date,
  ): Promise<void> {
    const event = push.msgKind === 'event' ? push.eventKind : null
    const key = push.eventKey ?? ''
    const subscribe = event === 'subscribe'
    const unsubscribe = event === 'unsubscribe'
    const scene = subscribe && key.startsWith('qrscene_') ? key.slice('qrscene_'.length) : null
    await this.txHost.tx.query(
      `INSERT INTO wxoa_fan (tenant_id, account_id, open_id, subscribed, subscribed_at, unsubscribed_at, qr_scene,
         last_inbound_at, last_event_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) AS n
       ON DUPLICATE KEY UPDATE
         subscribed = IF(?, n.subscribed, wxoa_fan.subscribed),
         subscribed_at = COALESCE(n.subscribed_at, wxoa_fan.subscribed_at),
         unsubscribed_at = COALESCE(n.unsubscribed_at, wxoa_fan.unsubscribed_at),
         qr_scene = IF(?, n.qr_scene, wxoa_fan.qr_scene),
         last_inbound_at = COALESCE(n.last_inbound_at, wxoa_fan.last_inbound_at),
         last_event_at = COALESCE(n.last_event_at, wxoa_fan.last_event_at)`,
      [
        accountTenantId,
        accountId,
        push.openId,
        !unsubscribe,
        subscribe ? now : null,
        unsubscribe ? now : null,
        scene?.slice(0, 64) ?? null,
        event ? null : now,
        event && WINDOW_EVENTS.has(event) ? now : null,
        subscribe || unsubscribe,
        subscribe,
      ],
    )
  }

  /** The passive reply going out, as an outbound row of the rule's content. */
  async record(accountId: number, push: WxoaPush, rule: WxoaReplyRule): Promise<void> {
    const repo = this.txHost.tx.getRepository(WxoaMessage)
    await repo.save(
      repo.create({
        accountId,
        openId: push.openId,
        direction: 'out',
        channel: 'passive',
        msgKind: rule.replyKind,
        payload: {
          ruleId: rule.id,
          ...rule.replyBody,
          ...(rule.materialId ? { materialId: rule.materialId } : {}),
        },
        sendState: 'sent',
        occurredAt: new Date(),
      }),
    )
  }
}

/** The value of `fn`, undefined when it refuses the push body. */
function parse<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch (err) {
    if (err instanceof WxoaXmlError) return undefined
    throw err
  }
}

/** Whether the push comes from a fan: a user message or an event the user triggered. */
function fanKind(push: WxoaPush): boolean {
  if (!push.known) return false
  return push.msgKind === 'event'
    ? FAN_EVENTS.has(push.eventKind ?? '')
    : USER_MESSAGES.has(push.msgKind)
}

/**
 * What tells a push from its retries: a user message's MsgId; an event's sender, time, kind, key, MsgID
 * (template and mass-send receipts) and publish_id (publish receipts); for a kind without its own
 * structure every common field.
 */
function dedupOf(push: WxoaPush): string {
  const { openId, createTime, msgKind, eventKind, eventKey, msgId, msgID } = push
  if (push.known && msgKind !== 'event') return ['m', msgId].join('|')
  if (push.known) {
    const info = push.payload.PublishEventInfo as { publish_id?: string } | undefined
    // 订阅通知事件同一秒可有多条（每次弹窗选的模板不同），按 List 里每项的 TemplateId:MsgID 区分
    const outer = WXOA_NOTICE_EVENTS[eventKind ?? '']
    const notice = outer ? (push.payload[outer] as { List?: Record<string, unknown>[] }) : undefined
    const noticeList = (notice?.List ?? [])
      .map((item) => `${String(item.TemplateId ?? '')}:${String(item.MsgID ?? '')}`)
      .join(',')
    return ['e', openId, createTime, eventKind, eventKey, msgID, info?.publish_id, noticeList].join(
      '|',
    )
  }
  return ['u', openId, createTime, msgKind, eventKind, eventKey, msgId, msgID].join('|')
}
