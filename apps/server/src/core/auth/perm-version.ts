import { Inject, Injectable } from '@nestjs/common'
import { redisKey } from '../redis/cache-namespaces.js'
import { REDIS, type Redis } from '../redis/redis.module.js'
import type { SessionUser } from './token.service.js'
import { USER_LOOKUP, type UserLookup } from './user-lookup.js'

/**
 * Permission versions (see docs/design-notes.md#permissions), the only way to make role/menu/user changes reach live sessions:
 * `auth:permver:{userId}` and `auth:permver:all` are counters; every session carries the pair it was
 * loaded with, and AuthGuard reloads the user when either moved (no key scans, no new sign-in).
 * Call the bump* methods AFTER the change is committed: bumping inside the transaction lets a
 * concurrent request reload the old rows under the new version and keep them.
 */
@Injectable()
export class PermVersion {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(USER_LOOKUP) private readonly lookup: UserLookup,
  ) {}

  /** `<user counter>.<global counter>`, missing counters = 0. */
  async current(userId: number): Promise<string> {
    const [user, all] = await this.redis.mGet([
      redisKey('authPermVer', userId),
      redisKey('authPermVer', 'all'),
    ])
    return `${user ?? 0}.${all ?? 0}`
  }

  /**
   * The user's session facts with their version. The version is read first, so a bump racing the
   * load leaves the session behind and the next request reloads again. null: user gone or disabled.
   */
  async load(userId: number): Promise<SessionUser | null> {
    const permVer = await this.current(userId)
    const user = await this.lookup.load(userId)
    return user && { ...user, permVer }
  }

  /** One user's roles, dept or enabled state changed. */
  async bumpUser(userId: number): Promise<void> {
    await this.redis.incr(redisKey('authPermVer', userId))
  }

  /** Several users at once, e.g. those of moved depts (their session's dept path changed). */
  async bumpUsers(ids: readonly number[]): Promise<void> {
    if (!ids.length) return
    const tx = this.redis.multi()
    for (const id of ids) tx.incr(redisKey('authPermVer', id))
    await tx.exec()
  }

  /** A role's grants, data scope or enabled state changed. */
  async bumpUsersOfRole(roleId: number): Promise<void> {
    await this.bumpUsers(await this.lookup.userIdsOfRole(roleId))
  }

  /** Any menu write: every session reloads its perms and every browser its menu routes. */
  async bumpAll(): Promise<void> {
    await this.redis.incr(redisKey('authPermVer', 'all'))
  }
}
