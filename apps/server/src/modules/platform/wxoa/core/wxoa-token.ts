import { forwardRef, Inject, Injectable } from '@nestjs/common'
import { Err } from '@qiwu/shared'
import { BizError } from '../../../../core/http/biz-error.js'
import { redisKey } from '../../../../core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../../../core/redis/redis.module.js'
import { WXOA_STABLE_TOKEN, WxoaGateway, type WxoaCaller } from './wxoa-gateway.js'

/** seconds a cached token is dropped before WeChat's `expires_in` ends */
const EARLY = 300
/** a token as it goes into a URL: printable ASCII */
const TOKEN = /^[\x21-\x7e]{1,1024}$/
/** The cache key of an account's token: by its (global) id, never by AppID. */
export const tokenKey = (accountId: number) => redisKey('wxoa', 'token', accountId)

/**
 * The accounts' access tokens (see docs/design-notes.md#wxoa): `stable_token` only, cached in Redis a
 * little shorter than WeChat keeps them under the account id, one request per account at a time within
 * the process. In its normal mode concurrent calls get the same token without revoking each other, so
 * several instances each fetching one is harmless and no Redis lock is taken; `force_refresh` is never
 * asked for.
 */
@Injectable()
export class WxoaTokenService {
  /**
   * the request in flight per account id: every caller meanwhile waits for the same answer. 按账号 id 而不是
   * AppID：同一 AppID 删除后再接入是新账号，绝不能拿到旧账号（可能是别的租户）的令牌或在途请求
   */
  private readonly inflight = new Map<number, Promise<string>>()

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    // the gateway injects this service too: forwardRef on both sides, and a structural type so no
    // class is read while the two files load each other
    @Inject(forwardRef(() => WxoaGateway))
    private readonly gateway: Pick<WxoaGateway, 'json'>,
  ) {}

  /**
   * The account's access token. `fresh` (testing a connection) asks WeChat itself, past the cache and
   * past a request in flight: that one may carry the AppSecret read before it was changed.
   */
  async get(account: WxoaCaller, opts: { fresh?: boolean } = {}): Promise<string> {
    const key = tokenKey(account.id)
    if (opts.fresh) return this.fetch(account, key)
    const cached = await this.redis.get(key)
    if (cached) return cached
    let pending = this.inflight.get(account.id)
    if (!pending) {
      pending = this.fetch(account, key).finally(() => this.inflight.delete(account.id))
      this.inflight.set(account.id, pending)
    }
    return pending
  }

  /** Forgets the cached token of account `accountId` (AppSecret changed, account deleted, token refused). */
  async drop(accountId: number): Promise<void> {
    await this.redis.unlink(tokenKey(accountId))
  }

  /**
   * 归属证明：用提交的 AppSecret 向微信换一次令牌（不缓存，令牌随即丢弃）。多租户下 AppID 全局唯一，
   * 新建账号先证明调用方持有这个公众号，否则一个租户可以抢先占用别人的 AppID；失败时抛出微信的错误码。
   */
  async prove(
    appId: string,
    accountKind: WxoaCaller['accountKind'],
    appSecret: string,
  ): Promise<void> {
    await this.request({ id: 0, appId, accountKind, appSecret })
  }

  /** stable_token 的令牌（形状不对即 B6001）与它的有效秒数。 */
  private async request(account: WxoaCaller): Promise<{ token: string; expiresIn: number }> {
    const answer = await this.gateway.json(account, WXOA_STABLE_TOKEN)
    const token = answer.access_token
    if (typeof token !== 'string' || !TOKEN.test(token)) throw new BizError(Err.WXOA_UPSTREAM)
    return { token, expiresIn: Number(answer.expires_in) }
  }

  private async fetch(account: WxoaCaller, key: string): Promise<string> {
    const { token, expiresIn } = await this.request(account)
    const ttl = Math.floor((Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 7200) - EARLY)
    await this.redis.set(key, token, {
      expiration: { type: 'PX', value: Math.max(60, ttl) * 1000 },
    })
    return token
  }
}
