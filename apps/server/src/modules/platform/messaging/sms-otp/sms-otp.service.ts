import { randomInt, timingSafeEqual } from 'node:crypto'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  DEFAULT_LOCALE,
  Err,
  type Locale,
  type SmsCodeBody,
  type SmsCodeVo,
  type SmsOtpScene,
} from '@qiwu/shared'
import type { DataSource, EntityManager } from 'typeorm'
import { smsIpBucket } from '../../../../core/auth/auth-params.js'
import { SessionRevoker } from '../../../../core/auth/session-revoker.js'
import { CaptchaTicketVerifier } from '../../../../core/captcha/captcha-ticket.js'
import { CaptchaService } from '../../../../core/captcha/captcha.service.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { currentLocale } from '../../../../core/i18n/locale.js'
import { NotifyDispatcher } from '../../../../core/notify/notify.js'
import { redisKey } from '../../../../core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../../../core/redis/redis.module.js'
import { ParamService } from '../../../../core/settings/param.service.js'
import { SmsChannel } from '../sms-channel/sms-channel.entity.js'
import { SmsNotifyChannel } from '../sms-template/sms-notify-channel.js'
import { SmsTemplate } from '../sms-template/sms-template.entity.js'
import { SmsOtp } from './sms-otp.entity.js'

const CODE_TTL_MS = 5 * 60_000
const VERIFY_WINDOW_SEC = 15 * 60
const DAY_TTL_SEC = 2 * 86_400
const READ_COMMITTED = { isolationLevel: 'READ COMMITTED' } as const
/**
 * The mobile as the limits count it: digits only, so `138-0013-8000` and `13800138000` share one
 * cooldown and daily cap (the contract's mobile syntax allows dashes).
 * A country-code prefix (`+86…` vs `138…`) still counts apart; normalize per region if needed.
 */
const limitKey = (mobile: string) => mobile.replace(/\D/g, '')

// One Redis operation checks every cap before changing the request counters.
const ISSUE_LIMIT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
for i = 2, 4 do
  if tonumber(redis.call('GET', KEYS[i]) or '0') >= tonumber(ARGV[i]) then return 0 end
end
if #KEYS == 6 then
  if redis.call('EXISTS', KEYS[5]) == 1 then return 0 end
  if tonumber(redis.call('GET', KEYS[6]) or '0') >= tonumber(ARGV[6]) then return 0 end
end
redis.call('SET', KEYS[1], '1', 'EX', ARGV[1])
if #KEYS == 6 then redis.call('SET', KEYS[5], '1', 'EX', ARGV[1]) end
for i = 2, 3 do
  if redis.call('INCR', KEYS[i]) == 1 then redis.call('EXPIRE', KEYS[i], ARGV[5]) end
end
if #KEYS == 6 then
  if redis.call('INCR', KEYS[6]) == 1 then redis.call('EXPIRE', KEYS[6], ARGV[5]) end
end
return tonumber(redis.call('GET', KEYS[2]))`

const SEND_LIMIT = `
if tonumber(redis.call('GET', KEYS[1]) or '0') >= tonumber(ARGV[1]) then return 0 end
if redis.call('INCR', KEYS[1]) == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return 1`

const VERIFY_LIMIT = `
for i = 1, 2 do
  if tonumber(redis.call('GET', KEYS[i]) or '0') >= tonumber(ARGV[i]) then return 0 end
end
for i = 1, 2 do
  if redis.call('INCR', KEYS[i]) == 1 then redis.call('EXPIRE', KEYS[i], ARGV[3]) end
end
return 1`

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name)

  constructor(
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly params: ParamService,
    private readonly captcha: CaptchaService,
    private readonly tickets: CaptchaTicketVerifier,
    private readonly sms: SmsNotifyChannel,
    private readonly dispatcher: NotifyDispatcher,
    @Inject(REDIS) private readonly redis: Redis,
    @InjectDataSource() private readonly ds: DataSource,
    revoker: SessionRevoker,
  ) {
    // SessionRevoker.revokeUser voids the unused codes of the user's mobile and bind requests. A plain read
    // first, never a join in the UPDATE: a non-root kick still holds the user row's lock in its
    // transaction, and a locking read of it here would wait for that transaction, which waits for us.
    revoker.onRevokeUser(async (userId) => {
      // a deleted user too (UserService.remove revokes after the soft delete): the number may be given
      // to another user at once, and its pending codes must not sign that one in
      const [user] = await this.ds.query<{ mobile: string | null }[]>(
        'SELECT mobile FROM iam_user WHERE id = ?', // qw:include-deleted
        [userId],
      )
      if (user?.mobile)
        await this.ds.query(
          'UPDATE msg_sms_otp SET consumed_at = ? WHERE mobile = ? AND consumed_at IS NULL AND deleted_at IS NULL',
          [new Date(), user.mobile],
        )
      await this.ds.query(
        'UPDATE msg_sms_otp SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL AND deleted_at IS NULL',
        [new Date(), userId],
      )
    })
  }

  async issue({ mobile, scene, captchaTicket }: SmsCodeBody, ip: string): Promise<SmsCodeVo> {
    if (
      (await this.captcha.mode()) !== 'off' &&
      !(await this.tickets.verify('sms_send', ip, captchaTicket))
    )
      throw new BizError(Err.AUTH_CAPTCHA_REQUIRED)

    return this.issueLimited(mobile, ip, (dailySeq, issuedAt) =>
      this.deliver(mobile, scene, ip, dailySeq, issuedAt, currentLocale()),
    )
  }

  /** Signed-in bind request: separate number limits, same other limits and immediate answer. */
  issueBind(userId: number, mobile: string, ip: string): Promise<SmsCodeVo> {
    return this.issueLimited(
      mobile,
      ip,
      (dailySeq, issuedAt) =>
        this.deliver(mobile, 'bind_mobile', ip, dailySeq, issuedAt, currentLocale(), userId),
      userId,
    )
  }

  private async issueLimited(
    mobile: string,
    ip: string,
    deliver: (dailySeq: number, issuedAt: Date) => Promise<void>,
    userId?: number,
  ): Promise<SmsCodeVo> {
    const [cooldownSec, mobileMax, ipMax, globalMax, userMax] = await Promise.all([
      this.params.int('sms.otp.cooldown_sec', 1, 3600, 60),
      this.params.int('sms.otp.mobile_daily_max', 1, 1000, 10),
      this.params.int('sms.otp.ip_daily_max', 1, 10_000, 20),
      this.params.int('sms.otp.global_daily_max', 1, 1_000_000, 1000),
      userId === undefined ? undefined : this.params.int('sms.otp.user_daily_max', 1, 1000, 5),
    ])
    const issuedAt = new Date()
    const day = issuedAt.toISOString().slice(0, 10)
    const number = limitKey(mobile)
    const dailySeq = Number(
      await this.redis.eval(ISSUE_LIMIT, {
        keys: [
          ...(userId === undefined
            ? [
                redisKey('smsLimit', 'cooldown', number),
                redisKey('smsLimit', 'mobile', day, number),
              ]
            : [
                redisKey('smsLimit', 'bind', 'cooldown', number),
                redisKey('smsLimit', 'bind', day, number),
              ]),
          redisKey('smsLimit', 'ip', day, smsIpBucket(ip)),
          redisKey('smsLimit', 'global', day),
          ...(userId === undefined
            ? []
            : [
                redisKey('smsLimit', 'user', 'cooldown', userId),
                redisKey('smsLimit', 'user', day, userId),
              ]),
        ],
        arguments: [
          String(cooldownSec),
          String(mobileMax),
          String(ipMax),
          String(globalMax),
          String(DAY_TTL_SEC),
          ...(userMax === undefined ? [] : [String(userMax)]),
        ],
      }),
    )
    if (!dailySeq) throw new BizError(Err.SMS_TOO_FREQUENT)

    // Everything that depends on the number runs after the answer: registered and unknown numbers
    // answer alike, also in time.
    this.dispatcher.track(deliver(dailySeq, issuedAt))
    return { cooldownSec }
  }

  /** Uses exactly the template/channel selection that delivery uses. */
  async smsConfigured(): Promise<boolean> {
    return !!(await this.resolveSender(this.ds.manager, DEFAULT_LOCALE))
  }

  private async resolveSender(manager: EntityManager, locale: Locale) {
    const template = (await manager
      .getRepository(SmsTemplate)
      .createQueryBuilder('template')
      .innerJoinAndMapOne(
        'template.channel',
        SmsChannel,
        'channel',
        'channel.id = template.channelId AND channel.enabled = :enabled',
        { enabled: true },
      )
      .where('template.code COLLATE utf8mb4_bin = :code AND template.enabled = :enabled', {
        code: 'auth.sms_code',
        enabled: true,
      })
      .orderBy(
        'CASE WHEN template.locale = :locale THEN 0 WHEN template.locale = :defaultLocale THEN 1 ELSE 2 END',
        'ASC',
      )
      .addOrderBy('template.id', 'ASC')
      .setParameters({ locale, defaultLocale: DEFAULT_LOCALE })
      .getOne()) as (SmsTemplate & { channel: SmsChannel }) | null
    return template ? { template, channel: template.channel } : null
  }

  async voidMobile(mobile: string): Promise<void> {
    await this.ds.query(
      'UPDATE msg_sms_otp SET consumed_at = ? WHERE mobile = ? AND consumed_at IS NULL AND deleted_at IS NULL',
      [new Date(), mobile],
    )
  }

  /**
   * The code row, its masked claimed record and the provider send, for an enabled user's number only.
   * READ COMMITTED: voiding the previous codes must not gap-lock the index range the INSERT then needs
   * (two numbers in one gap deadlock under REPEATABLE READ).
   * Deliveries may commit out of order, so the row is dated by its issue and voids only codes issued
   * before it; consume takes only the newest issued code (the cooldown keeps issues >= 1 s apart).
   */
  private async deliver(
    mobile: string,
    scene: SmsOtpScene,
    ip: string,
    dailySeq: number,
    issuedAt: Date,
    locale: Locale,
    userId?: number,
  ): Promise<void> {
    const send = await this.txHost.withTransaction(READ_COMMITTED, async () => {
      const [user] = await this.txHost.tx.query<{ id: number; enabled: number }[]>(
        'SELECT id, enabled FROM iam_user WHERE mobile = ? AND deleted_at IS NULL LIMIT 1',
        [mobile],
      )
      if (userId === undefined ? !user || Number(user.enabled) !== 1 : !!user) return null

      const sender = await this.resolveSender(this.txHost.tx, locale)
      if (!sender) {
        this.logger.warn('SMS OTP template or channel unavailable')
        return null
      }
      const globalMax = await this.params.int('sms.otp.global_daily_max', 1, 1_000_000, 1000)
      const allowed = await this.redis.eval(SEND_LIMIT, {
        keys: [redisKey('smsLimit', 'global', new Date().toISOString().slice(0, 10))],
        arguments: [String(globalMax), String(DAY_TTL_SEC)],
      })
      if (Number(allowed) !== 1) {
        this.logger.warn('SMS OTP global daily limit reached before delivery')
        return null
      }
      const { template } = sender

      const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
      const now = new Date()
      const repo = this.txHost.tx.getRepository(SmsOtp)
      const query = repo
        .createQueryBuilder()
        .update()
        .set({ consumedAt: now })
        .where(
          'mobile = :mobile AND scene = :scene AND consumed_at IS NULL AND created_at < :issuedAt',
          {
            mobile,
            scene,
            issuedAt,
          },
        )
      if (scene === 'bind_mobile') query.andWhere('user_id = :userId', { userId })
      await query.execute()
      await repo.save({
        mobile,
        userId: userId ?? null,
        scene,
        code,
        attempts: 0,
        dailySeq,
        requestIp: ip,
        consumedAt: null,
        consumedIp: null,
        createdAt: issuedAt,
      })
      const recordId = await this.sms.writeClaimed({
        template,
        recipient: { userId: userId ?? user!.id, email: null, mobile, locale, timezone: 'UTC' },
        params: { code },
        values: { code },
      })
      const paramOrder =
        Array.isArray(template.paramNames) &&
        template.paramNames.every((name) => typeof name === 'string')
          ? (template.paramNames as string[])
          : ['code']
      return {
        recordId,
        message: {
          mobile,
          body: template.body.replaceAll('{code}', code),
          templateId: template.providerTemplateId,
          params: { code },
          paramOrder,
        },
      }
    })
    if (send) await this.sms.sendClaimed(send.recordId, send.message)
  }

  async consume(
    {
      mobile,
      scene,
      code,
      userId,
    }: { mobile: string; scene: SmsOtpScene; code: string; userId?: number },
    ip: string,
  ): Promise<boolean> {
    const allowed = await this.redis.eval(VERIFY_LIMIT, {
      keys: [
        redisKey('smsLimit', 'verify', 'mobile', limitKey(mobile), scene),
        redisKey('smsLimit', 'verify', 'ip', smsIpBucket(ip)),
      ],
      arguments: ['10', '30', String(VERIFY_WINDOW_SEC)],
    })
    if (Number(allowed) !== 1) throw new BizError(Err.SMS_TOO_FREQUENT)

    return this.txHost.withTransaction(async () => {
      const repo = this.txHost.tx.getRepository(SmsOtp)
      const query = repo
        .createQueryBuilder('o')
        .where('o.mobile = :mobile AND o.scene = :scene AND o.createdAt > :since', {
          mobile,
          scene,
          since: new Date(Date.now() - CODE_TTL_MS),
        })
      if (scene === 'bind_mobile') {
        if (userId === undefined) return false
        query.andWhere('o.userId = :userId', { userId })
      }
      const row = await query
        .orderBy('o.createdAt', 'DESC')
        .addOrderBy('o.id', 'DESC')
        .setLock('pessimistic_write')
        .getOne()
      if (!row || row.consumedAt) return false
      const expected = Buffer.from(row.code)
      const supplied = Buffer.from(code)
      const correct = expected.length === supplied.length && timingSafeEqual(expected, supplied)
      if (correct) {
        const changed = await repo
          .createQueryBuilder()
          .update()
          .set({ consumedAt: new Date(), consumedIp: ip })
          .where('id = :id AND consumed_at IS NULL', { id: row.id })
          .execute()
        return changed.affected === 1
      }
      const attempts = row.attempts + 1
      await repo
        .createQueryBuilder()
        .update()
        .set({ attempts, consumedAt: attempts >= 5 ? new Date() : null })
        .where('id = :id AND consumed_at IS NULL', { id: row.id })
        .execute()
      return false
    })
  }
}
