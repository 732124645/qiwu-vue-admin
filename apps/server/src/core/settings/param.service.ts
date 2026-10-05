import { Inject, Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import type { DataSource } from 'typeorm'
import { keyPart, keyPattern, redisKey } from '../redis/cache-namespaces.js'
import { REDIS, type Redis } from '../redis/redis.module.js'
import { droppedBy, readThrough } from './dict.service.js'

interface CachedParam {
  value: string
  isPublic: boolean
}

/**
 * Runtime parameters (`cfg_param`) through the Redis `param:{key}` cache, filled
 * version-checked against `param:ver:{key}` (`readThrough`: a stale read racing a write, e.g. one
 * making the param non-public, is never cached). Values are strings; callers parse them and fall
 * back to their defaults (`@qiwu/shared` params.ts).
 */
@Injectable()
export class ParamService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** The value, or null when the key does not exist. */
  async get(key: string): Promise<string | null> {
    return (await this.load(key))?.value ?? null
  }

  /** An integer param in [min, max]; missing, blank or out of range → `fallback` (params are admin-edited strings). */
  async int(key: string, min: number, max: number, fallback: number): Promise<number> {
    const raw = (await this.get(key))?.trim()
    const n = Number(raw)
    return raw && Number.isInteger(n) && n >= min && n <= max ? n : fallback
  }

  /**
   * Readable before sign-in (`is_public`, never a secret one); null for missing and non-public keys
   * alike.
   */
  async getPublic(key: string): Promise<string | null> {
    const p = await this.load(key)
    return p?.isPublic ? p.value : null
  }

  /**
   * After any write to the params `keys` (after the commit), or a cache clear (the cache monitor):
   * new versions, cached values dropped; returns how many were cached.
   */
  async invalidate(...keys: string[]): Promise<number> {
    if (!keys.length) return 0
    const tx = this.redis.multi()
    for (const k of new Set(keys)) tx.incr(redisKey('paramVer', k)).unlink(redisKey('param', k))
    return droppedBy(await tx.exec())
  }

  /**
   * Every param and every cached one (the settings page's "refresh cache", e.g. after db:seed or SQL;
   * the cache monitor's clear).
   */
  async invalidateAll(): Promise<number> {
    // qw:include-deleted a deleted param's value may still be cached
    const rows = await this.ds.query<{ param_key: string }[]>('SELECT param_key FROM cfg_param')
    const keys = new Set(rows.map((r) => r.param_key))
    // cached values of params deleted behind the API's back too; a value key holds no raw `:` after
    // the namespace (parts are encoded), a version key does
    const head = redisKey('param', '')
    for await (const found of this.redis.scanIterator({ MATCH: keyPattern('param'), COUNT: 500 }))
      for (const k of found) {
        const key = k.slice(head.length).includes(':') ? undefined : keyPart(k.slice(head.length))
        if (key !== undefined) keys.add(key)
      }
    return this.invalidate(...keys)
  }

  private load(key: string): Promise<CachedParam | null> {
    return readThrough(this.redis, redisKey('param', key), redisKey('paramVer', key), async () => {
      const [row] = await this.ds.query<
        { param_value: string; is_public: number; is_secret: number }[]
      >(
        'SELECT param_value, is_public, is_secret FROM cfg_param WHERE param_key = ? AND deleted_at IS NULL',
        [key],
      )
      if (!row) return null
      // a secret one never, whatever its flag says (the settings page refuses the pair too)
      return {
        value: row.param_value,
        isPublic: Number(row.is_public) === 1 && Number(row.is_secret) !== 1,
      }
    })
  }
}
