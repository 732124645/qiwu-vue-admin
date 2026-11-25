import { redisKey } from '../redis/cache-namespaces.js'
import type { Redis } from '../redis/redis.module.js'
import type { ParamService } from '../settings/param.service.js'
import type { SessionRevoker } from './session-revoker.js'
import {
  APP_SESSION_EXPIRED,
  appSessionDays,
  appSessionExpiry,
  isAppSession,
  MAX_SESSION_MS,
  type Session,
} from './token.service.js'

/** What the sweep needs to end App sessions the current `auth.mobile.session_days` no longer allows. */
export interface AppSweep {
  params: ParamService
  revoker: SessionRevoker
}

/**
 * The `session.sweep` job: drops ended sessions from the online indexes, the trims a
 * sign-in does too (TokenService ISSUE) for when nobody signs in for a while: `auth:online` members whose
 * refresh expired, `auth:seen` entries older than any session lives. Session keys expire by themselves.
 * With `app` it also ends the App sessions past their term under the current param (lowered after they
 * signed in), without waiting for their next refresh. Returns how many entries went.
 */
export async function sweepOnline(redis: Redis, now = Date.now(), app?: AppSweep): Promise<number> {
  const [online, seen] = await redis
    .multi()
    .zRemRangeByScore(redisKey('authOnline'), '-inf', now)
    .zRemRangeByScore(redisKey('authSeen'), '-inf', now - MAX_SESSION_MS)
    .exec()
  return Number(online) + Number(seen) + (app ? await sweepApp(redis, now, app) : 0)
}

/**
 * 结束按当前参数已到期的 App 会话（`appSessionExpiry`，与刷新同一规则）。0 模式下滑动期限总在未来，
 * 不结束任何会话：那时只有 400 天未打开的会话到期，由会话键自身的 TTL 处理。一次 MGET 全部在线会话，
 * 与在线列表同一上限。
 */
async function sweepApp(redis: Redis, now: number, { params, revoker }: AppSweep) {
  const days = await appSessionDays(params)
  if (days === 0) return 0
  const sids = await redis.zRange(redisKey('authOnline'), 0, -1)
  if (!sids.length) return 0
  const raws = await redis.mGet(sids.map((sid) => redisKey('authSession', sid)))
  const expired = sids.filter((_, i) => {
    const raw = raws[i]
    if (!raw) return false
    const s = JSON.parse(raw) as Session
    return isAppSession(s) && now >= appSessionExpiry(s, days, now)
  })
  const ended = await Promise.all(
    expired.map((sid) => revoker.revokeSession(sid, APP_SESSION_EXPIRED)),
  )
  return ended.filter(Boolean).length
}
