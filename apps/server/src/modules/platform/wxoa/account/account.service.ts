import { randomBytes } from 'node:crypto'
import { Injectable, NotFoundException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  Err,
  type Page,
  type WxoaAccountCreate,
  type WxoaAccountDetailVo,
  type WxoaAccountOption,
  type WxoaAccountQuery,
  type WxoaAccountTestVo,
  type WxoaAccountUpdate,
  type WxoaAccountVo,
  type WxoaQuotaVo,
  wxoaAccountUpdate,
} from '@qiwu/shared'
import type { SelectQueryBuilder } from 'typeorm'
import { AppConfigService } from '../../../../core/config/config.module.js'
import { SecretBox } from '../../../../core/crypto/secret-box.js'
import { BaseCrudService } from '../../../../core/db/base-crud.service.js'
import { contains } from '../../../../core/db/page.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { parseOr400 } from '../../../../core/http/validation.pipe.js'
import { WxoaAccount } from '../core/wxoa.entity.js'
import { WxoaGateway } from '../core/wxoa-gateway.js'
import { WxoaTokenService } from '../core/wxoa-token.js'

/** The APIs whose daily quota the account page shows: the ones this module calls most. */
const QUOTA_APIS = [
  '/cgi-bin/message/custom/send',
  '/cgi-bin/message/template/send',
  '/cgi-bin/menu/create',
  '/cgi-bin/user/get',
  '/cgi-bin/user/info',
  '/cgi-bin/user/info/batchget',
  '/cgi-bin/tags/members/batchtagging',
  '/cgi-bin/material/add_material',
  '/cgi-bin/media/upload',
  '/cgi-bin/media/get',
  '/cgi-bin/qrcode/create',
]

/** quota/get's answer for a path the account may not call (76022) or WeChat does not know (76021) */
const QUOTA_PATH_REFUSED = new Set([76021, 76022])
/** An API the account may not call, as the gateway or quota/get reports it. */
const notCallable = (err: unknown) =>
  err instanceof BizError &&
  (err.err === Err.WXOA_API_UNAUTHORIZED ||
    (err.err === Err.WXOA_UPSTREAM_REFUSED && QUOTA_PATH_REFUSED.has(Number(err.params.errcode))))

const iso = (d: Date | null) => d?.toISOString() ?? null
const int = (v: unknown) => Math.trunc(Number(v)) || 0

/** The row as every answer shows it: never a secret column, never the callback key itself. */
const vo = (a: WxoaAccount): WxoaAccountVo => ({
  id: a.id,
  label: a.label,
  appId: a.appId,
  accountKind: a.accountKind,
  verified: a.verified,
  cryptoMode: a.cryptoMode,
  enabled: a.enabled,
  lastPushAt: iso(a.lastPushAt),
  note: a.note,
  createdAt: a.createdAt.toISOString(),
  updatedAt: a.updatedAt.toISOString(),
})

/**
 * Official Accounts (see docs/design-notes.md#wxoa). The AppSecret, Token and EncodingAESKey are
 * write-only: boxed by SecretBox into columns never selected unless asked for, answered as `has*` only;
 * an empty or absent one on update keeps the stored value. A new AppSecret or a deleted account drops
 * the account's cached access token. Calls to WeChat need the account alive (404) and enabled (`B6011`).
 */
@Injectable()
export class WxoaAccountService extends BaseCrudService<WxoaAccount> {
  constructor(
    txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly box: SecretBox,
    private readonly tokens: WxoaTokenService,
    private readonly gateway: WxoaGateway,
    private readonly cfg: AppConfigService,
  ) {
    super(txHost, WxoaAccount)
  }

  async list(query: WxoaAccountQuery): Promise<Page<WxoaAccountVo>> {
    const { items, total } = await this.page(query)
    return { items: items.map(vo), total }
  }

  /** Live accounts, disabled ones included (the switch marks them). */
  async options(): Promise<WxoaAccountOption[]> {
    const rows = await this.repo.find({ order: { id: 'ASC' } })
    return rows.map(({ id, label, accountKind, verified, enabled }) => ({
      id,
      label,
      accountKind,
      verified,
      enabled,
    }))
  }

  async detail(id: number): Promise<WxoaAccountDetailVo> {
    const row = await this.withSecrets(id)
    return {
      ...vo(row),
      callbackPath: `/api/wxoa/callback/${row.callbackKey}`,
      hasAppSecret: !!row.appSecretEnc,
      hasToken: !!row.pushTokenEnc,
      hasAesKey: !!row.aesKeyEnc,
    }
  }

  /**
   * 新建账号。多租户开关打开时 AppID 跨租户唯一（docs/design-notes.md#wxoa）：先用提交的 AppSecret 换一次
   * 令牌证明持有这个公众号，失败即报微信的错误码、不建行，AppID 不被占用。
   */
  async add(dto: WxoaAccountCreate): Promise<WxoaAccountDetailVo> {
    const { appSecret, token, aesKey, ...fields } = dto
    const cryptoMode = fields.cryptoMode ?? 'plain'
    if (cryptoMode !== 'plain' && !aesKey) throw new BizError(Err.WXOA_AES_KEY_REQUIRED)
    if (this.cfg.get('APP_MULTI_TENANT'))
      await this.tokens.prove(fields.appId, fields.accountKind, appSecret)
    const { id } = await this.create({
      ...fields,
      cryptoMode,
      appSecretEnc: this.box.encrypt(appSecret),
      pushTokenEnc: this.box.encrypt(token),
      aesKeyEnc: aesKey ? this.box.encrypt(aesKey) : null,
      callbackKey: randomBytes(16).toString('base64url'),
    })
    return this.detail(id)
  }

  /**
   * Changes the fields sent. The kind and mode as the change leaves them must agree (400), compat and
   * secure need an EncodingAESKey sent or stored (`B6008`). The token cache is dropped inside the
   * transaction: when that fails nothing changes.
   */
  change(id: number, dto: WxoaAccountUpdate): Promise<void> {
    const { appSecret, token, aesKey, ...fields } = dto
    return this.txHost.withTransaction(async () => {
      await this.lockScopedIds([id])
      const stored = await this.withSecrets(id)
      const cryptoMode = fields.cryptoMode ?? stored.cryptoMode
      parseOr400(wxoaAccountUpdate, {
        accountKind: fields.accountKind ?? stored.accountKind,
        cryptoMode,
      })
      if (cryptoMode !== 'plain' && !aesKey && !stored.aesKeyEnc)
        throw new BizError(Err.WXOA_AES_KEY_REQUIRED)
      await this.update(id, {
        ...fields,
        appSecretEnc: appSecret ? this.box.encrypt(appSecret) : undefined,
        pushTokenEnc: token ? this.box.encrypt(token) : undefined,
        aesKeyEnc: aesKey ? this.box.encrypt(aesKey) : undefined,
      })
      if (appSecret) await this.tokens.drop(id)
    })
  }

  /** Deletes the account row only (its fans, messages … stay) and drops its cached token. */
  drop(id: number): Promise<void> {
    return this.txHost.withTransaction(async () => {
      await this.lockScopedIds([id])
      await this.repo.findOneByOrFail({ id })
      await this.deleteRows([id])
      await this.tokens.drop(id)
    })
  }

  /**
   * A token fetched past the cache (a wrong AppSecret shows at once), then an API call with it; the
   * first failure's code (and the refused IP WeChat named) is reported, not thrown.
   */
  async test(id: number): Promise<WxoaAccountTestVo> {
    const account = await this.caller(id)
    const result: WxoaAccountTestVo = {
      tokenOk: false,
      apiOk: false,
      code: null,
      ip: null,
      lastPushAt: iso(account.lastPushAt),
    }
    try {
      await this.tokens.get(account, { fresh: true })
      result.tokenOk = true
      await this.gateway.json(account, '/cgi-bin/get_api_domain_ip')
      result.apiOk = true
    } catch (err) {
      if (!(err instanceof BizError)) throw err
      result.code = err.err.code
      result.ip = typeof err.params.ip === 'string' && err.params.ip ? err.params.ip : null
    }
    return result
  }

  /**
   * Today's quota of each API of the list; one the account may not call (`B6003`, or quota/get's own
   * 76021 / 76022) is left out. None left: `B6003`.
   */
  async quota(id: number): Promise<WxoaQuotaVo> {
    const account = await this.caller(id)
    const out: WxoaQuotaVo = []
    for (const api of QUOTA_APIS) {
      let quota: Record<string, unknown>
      try {
        const answer = await this.gateway.json(account, '/cgi-bin/openapi/quota/get', {
          body: { cgi_path: api },
        })
        quota = (answer.quota ?? {}) as Record<string, unknown>
      } catch (err) {
        if (notCallable(err)) continue
        throw err
      }
      out.push({
        api,
        dailyLimit: int(quota.daily_limit),
        used: int(quota.used),
        remain: int(quota.remain),
      })
    }
    if (!out.length) throw new BizError(Err.WXOA_API_UNAUTHORIZED)
    return out
  }

  /** Resets the account's API call counts (the gateway signs it with the AppSecret). */
  async clearQuota(id: number): Promise<void> {
    await this.gateway.json(await this.caller(id), '/cgi-bin/clear_quota/v2')
  }

  protected override filter(
    qb: SelectQueryBuilder<WxoaAccount>,
    { label, appId, accountKind, enabled }: WxoaAccountQuery,
  ): SelectQueryBuilder<WxoaAccount> {
    if (label) qb.andWhere('t.label LIKE :label', { label: contains(label) })
    if (appId) qb.andWhere('t.appId LIKE :appId', { appId: contains(appId) })
    if (accountKind) qb.andWhere('t.accountKind = :accountKind', { accountKind })
    if (enabled !== undefined) qb.andWhere('t.enabled = :enabled', { enabled })
    return qb
  }

  /** Live account `id` with its secret columns (404). */
  private async withSecrets(id: number): Promise<WxoaAccount> {
    const row = await this.repo
      .createQueryBuilder('t')
      .addSelect(['t.appSecretEnc', 't.pushTokenEnc', 't.aesKeyEnc'])
      .where('t.id = :id', { id })
      .getOne()
    if (!row) throw new NotFoundException()
    return row
  }

  /** Live account `id` (404), enabled (`B6011`): the caller of a WeChat API. */
  private async caller(id: number): Promise<WxoaAccount> {
    const row = await this.get(id)
    if (!row.enabled) throw new BizError(Err.WXOA_ACCOUNT_DISABLED)
    return row
  }
}
