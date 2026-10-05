import { Inject, Injectable, Logger } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import {
  WX_SUBSCRIBE_ENABLED_PARAM,
  WX_SUBSCRIBE_TEMPLATES_PARAM,
  wxSubscribeTemplates,
  type WxSubscribeTemplates,
} from '@qiwu/shared'
import type { DataSource } from 'typeorm'
import { formatInZone } from '../../../../core/excel/excel.js'
import { currentTimezone, timezoneOf } from '../../../../core/i18n/locale.js'
import { fillTemplate } from '../../../../core/notify/notify.js'
import { redisKey } from '../../../../core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../../../core/redis/redis.module.js'
import { ParamService } from '../../../../core/settings/param.service.js'
import { type DeliveredInbox, InboxChannel } from '../../messaging/inbox/inbox.channel.js'
import { WxMpGateway } from './wx-mp.gateway.js'
import { WX_MP } from './wx-mp.service.js'

/** WeChat's value limits per field type (code points); `time`/`date`/`number`… are sent as given. */
const LIMITS = new Map(
  Object.entries({ thing: 20, name: 10, phrase: 5, character_string: 32, letter: 32, symbol: 5 }),
)
const clip = (key: string, value: string) => {
  const max = LIMITS.get(key.replace(/\d+$/, ''))
  return max ? Array.from(value).slice(0, max).join('') : value
}
/** a refused access token (invalid, expired, malformed): fetch a new one and send once more */
const STALE_TOKEN = new Set([40001, 42001, 40014])
/** the user has no one-time quota left for the template: the normal "not subscribed" answer */
const NO_QUOTA = 43101

/**
 * WeChat one-time subscribe messages: attached to inbox delivery like the `notify:new` push
 * (no table, no retry, no subscription bookkeeping: WeChat keeps the quota). While
 * `notify.wx_subscribe.enabled` is on and the app is configured, a delivered row whose notify code maps to a
 * template id sends one `subscribeMessage.send` to the recipient's live `wx-mp` binding of that app. The
 * access token (`stable_token`) is cached in Redis `wxmp:token:{appid}` (masked); the AppSecret, the token
 * and WeChat's answers never reach a log or a response (errcodes only).
 */
@Injectable()
export class WxSubscribeService {
  private readonly logger = new Logger(WxSubscribeService.name)
  /** the templates value last found invalid: warned once per value */
  private invalid: string | null = null

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly gateway: WxMpGateway,
    private readonly params: ParamService,
    inbox: InboxChannel,
  ) {
    inbox.onDelivered((row) => this.push(row))
  }

  /** The template ids the caller's mini program may ask for: none unless on, configured and bound. */
  async templateIds(userId: number): Promise<string[]> {
    const on = await this.active()
    if (!on || !(await this.recipient(userId, on.appid))) return []
    return [...new Set(Object.values(on.templates).map((t) => t.id))].filter(Boolean)
  }

  async push(row: DeliveredInbox): Promise<void> {
    const on = await this.active()
    const tpl =
      on && Object.hasOwn(on.templates, row.templateCode) && on.templates[row.templateCode]
    if (!on || !tpl || !tpl.id) return
    const to = await this.recipient(row.userId, on.appid)
    if (!to) return
    const tz = timezoneOf(to.timezone ?? undefined) ?? (await currentTimezone(this.params, null))
    const values: Record<string, string> = {}
    for (const [k, v] of Object.entries(row.params ?? {}))
      if (typeof v === 'string' || typeof v === 'number') values[k] = String(v)
    values.title = row.title
    values.time = formatInZone(new Date(row.createdAt), tz).slice(0, 16)
    const body = {
      touser: to.openid,
      template_id: tpl.id,
      ...(tpl.page && {
        page: fillTemplate(
          tpl.page,
          Object.fromEntries(Object.entries(values).map(([k, v]) => [k, encodeURIComponent(v)])),
        ),
      }),
      data: Object.fromEntries(
        Object.entries(tpl.data).map(([k, v]) => [k, { value: clip(k, fillTemplate(v, values)) }]),
      ),
      miniprogram_state: tpl.state ?? 'formal',
      lang: row.locale === 'en-US' ? ('en_US' as const) : ('zh_CN' as const),
    }
    let errcode = await this.gateway.subscribeSend(await this.token(on.appid), body)
    if (STALE_TOKEN.has(errcode)) {
      await this.redis.unlink(redisKey('wxMp', 'token', on.appid))
      errcode = await this.gateway.subscribeSend(await this.token(on.appid), body)
    }
    if (errcode === NO_QUOTA) this.logger.debug(`Inbox ${row.id}: no WeChat subscription`)
    else if (errcode) this.logger.warn(`Inbox ${row.id}: WeChat subscribe send errcode ${errcode}`)
  }

  /** The app and the templates while the switch is on and the app configured; else null. */
  private async active(): Promise<{ appid: string; templates: WxSubscribeTemplates } | null> {
    if ((await this.params.get(WX_SUBSCRIBE_ENABLED_PARAM)) !== 'true') return null
    const appid = this.gateway.appid()
    if (!appid) return null
    const raw = (await this.params.get(WX_SUBSCRIBE_TEMPLATES_PARAM)) ?? ''
    let parsed: ReturnType<typeof wxSubscribeTemplates.safeParse> | undefined
    try {
      parsed = wxSubscribeTemplates.safeParse(JSON.parse(raw))
    } catch {
      parsed = undefined
    }
    if (parsed?.success) return { appid, templates: parsed.data }
    if (this.invalid !== raw)
      this.logger.warn(`Param ${WX_SUBSCRIBE_TEMPLATES_PARAM} is invalid: no WeChat reminders`)
    this.invalid = raw
    return null
  }

  /** The user's live binding of `appid` and stored zone, or undefined. */
  private async recipient(userId: number, appid: string) {
    const [row] = await this.ds.query<{ openid: string; timezone: string | null }[]>(
      `SELECT s.openid, u.timezone FROM iam_user_social s JOIN iam_user u ON u.id = s.user_id
        WHERE s.user_id = ? AND s.provider = ? AND s.appid = ? AND s.deleted_at IS NULL
          AND u.deleted_at IS NULL`,
      [userId, WX_MP, appid],
    )
    return row
  }

  /** The cached access token (expires 5 minutes early), else a new stable one. */
  private async token(appid: string): Promise<string> {
    const key = redisKey('wxMp', 'token', appid)
    const cached = await this.redis.get(key)
    if (cached) return cached
    const { token, expiresIn } = await this.gateway.stableToken()
    await this.redis.set(key, token, {
      expiration: { type: 'PX', value: Math.max(60, expiresIn - 300) * 1000 },
    })
    return token
  }
}
