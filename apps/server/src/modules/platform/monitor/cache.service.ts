import { Inject, Injectable, NotFoundException } from '@nestjs/common'
import {
  CACHE_SCAN_MAX,
  type CacheKeysVo,
  type CacheNamespaceVo,
  type CacheValueVo,
  Err,
} from '@qiwu/shared'
import {
  CACHE_NAMESPACES,
  type CacheNamespaceName,
  keyPart,
  keyPattern,
  keyPrefix,
  redisKey,
} from '../../../core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../../core/redis/redis.module.js'
import { BizError } from '../../../core/http/biz-error.js'
import { DictService } from '../../../core/settings/dict.service.js'
import { ParamService } from '../../../core/settings/param.service.js'

/** Items of a hash / list / set / zset value shown, and characters of a string value. */
const VALUE_ITEMS_MAX = 100
const VALUE_TEXT_MAX = 65_536
const SCAN_COUNT = 500

const NAMES = Object.keys(CACHE_NAMESPACES) as CacheNamespaceName[]
// longest prefix first: `auth:rt:grace:` keys are not `auth:rt:` ones
const BY_PREFIX = [...NAMES].sort(
  (a, b) => CACHE_NAMESPACES[b].prefix.length - CACHE_NAMESPACES[a].prefix.length,
)

/** The registered namespace a key (without the global prefix) belongs to: its longest prefix. */
const namespaceOf = (key: string): CacheNamespaceName | undefined =>
  BY_PREFIX.find((n) => key.startsWith(CACHE_NAMESPACES[n].prefix))

/**
 * The cache monitor over the key registry (core/redis/cache-namespaces.ts): only registered
 * namespaces are listed, read or cleared, keys only by SCAN under the app's prefix (`qw:`, the ACL
 * user's only keys), `masked` values never leave the server, only `clearable` namespaces are deleted
 * (never `auth:*`: sessions end through SessionRevoker; never the `dict:ver:` / `param:ver:` versions, shown
 * read-only). Cached dicts and params are cleared through DictService / ParamService, which bump their
 * versions: a plain delete would let a fill that read the database before the clear store its
 * stale value after it. Keys travel without the global prefix.
 */
@Injectable()
export class CacheMonitorService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly dicts: DictService,
    private readonly params: ParamService,
  ) {}

  namespaces(): CacheNamespaceVo[] {
    return NAMES.map((name) => ({ name, ...CACHE_NAMESPACES[name] }))
  }

  /** Keys of one namespace, sorted; SCAN stops after `CACHE_SCAN_MAX` (`truncated`). Unknown → 404. */
  async keys(ns: string): Promise<CacheKeysVo> {
    const name = this.known(ns)
    const keys: string[] = []
    for await (const key of this.scan(name)) {
      if (keys.length === CACHE_SCAN_MAX) return { keys: keys.sort(), truncated: true }
      keys.push(key)
    }
    return { keys: keys.sort(), truncated: false }
  }

  /** Type, TTL and (unless masked) the value, capped; a key outside every namespace → 404. */
  async value(key: string): Promise<CacheValueVo> {
    const name = namespaceOf(key)
    if (!name) throw new NotFoundException()
    const full = keyPrefix() + key
    const [type, ttl] = await Promise.all([this.redis.type(full), this.redis.ttl(full)])
    const masked = CACHE_NAMESPACES[name].masked
    return {
      key,
      type,
      ttl,
      masked,
      value: masked || type === 'none' ? null : await this.read(full, type),
    }
  }

  /** Deletes a clearable namespace's keys or one key of one; unknown → 404, not clearable → 422. */
  async clear(q: { ns?: string; key?: string }): Promise<{ deleted: number }> {
    if (q.key !== undefined) {
      const name = namespaceOf(q.key)
      if (!name) throw new NotFoundException()
      this.assertClearable(name)
      return { deleted: await this.clearKey(name, q.key) }
    }
    const name = this.known(q.ns!)
    this.assertClearable(name)
    return { deleted: await this.clearNamespace(name) }
  }

  /** Every clearable namespace (never `auth:*` nor the versions). */
  async clearAll(): Promise<{ deleted: number }> {
    let deleted = 0
    for (const name of NAMES)
      if (CACHE_NAMESPACES[name].clearable) deleted += await this.clearNamespace(name)
    return { deleted }
  }

  /** Dicts and params (every one, cached or being filled) through their services, then the rest. */
  private async clearNamespace(name: CacheNamespaceName): Promise<number> {
    const dropped =
      name === 'dict'
        ? await this.dicts.invalidateAll()
        : name === 'param'
          ? await this.params.invalidateAll()
          : 0
    return dropped + (await this.unlinkAll(name))
  }

  /** A cached dict / param through its service; any other key (another shape) by UNLINK. */
  private async clearKey(name: CacheNamespaceName, key: string): Promise<number> {
    const full = keyPrefix() + key
    const tail = key.slice(CACHE_NAMESPACES[name].prefix.length)
    if (name === 'dict') {
      const code = keyPart(tail.replace(/^entries:/, ''))
      if (code !== undefined && redisKey('dict', 'entries', code) === full)
        return this.dicts.invalidate(code)
    }
    if (name === 'param') {
      const param = keyPart(tail)
      if (param !== undefined && redisKey('param', param) === full)
        return this.params.invalidate(param)
    }
    return this.redis.unlink(full)
  }

  private known(ns: string): CacheNamespaceName {
    if (!Object.hasOwn(CACHE_NAMESPACES, ns)) throw new NotFoundException()
    return ns as CacheNamespaceName
  }

  private assertClearable(name: CacheNamespaceName) {
    if (!CACHE_NAMESPACES[name].clearable) throw new BizError(Err.UNPROCESSABLE)
  }

  /** The namespace's keys without the global prefix (not those of a longer registered prefix). */
  private async *scan(name: CacheNamespaceName): AsyncGenerator<string> {
    const head = keyPrefix().length
    for await (const found of this.redis.scanIterator({
      MATCH: keyPattern(name),
      COUNT: SCAN_COUNT,
    }))
      for (const full of found) {
        const key = full.slice(head)
        if (namespaceOf(key) === name) yield key
      }
  }

  private async unlinkAll(name: CacheNamespaceName): Promise<number> {
    let batch: string[] = []
    let deleted = 0
    for await (const key of this.scan(name)) {
      batch.push(keyPrefix() + key)
      if (batch.length === SCAN_COUNT) {
        deleted += await this.redis.unlink(batch)
        batch = []
      }
    }
    if (batch.length) deleted += await this.redis.unlink(batch)
    return deleted
  }

  /** The value by type, at most `VALUE_ITEMS_MAX` items / `VALUE_TEXT_MAX` characters. */
  private async read(full: string, type: string): Promise<unknown> {
    const last = VALUE_ITEMS_MAX - 1
    switch (type) {
      case 'string':
        return (await this.redis.get(full))?.slice(0, VALUE_TEXT_MAX) ?? null
      case 'list':
        return this.redis.lRange(full, 0, last)
      case 'zset':
        return this.redis.zRangeWithScores(full, 0, last)
      case 'hash': {
        // one HSCAN page: a big hash is shown in part (flat field, value pairs)
        const [, flat] = await this.redis.sendCommand<[string, string[]]>([
          'HSCAN',
          full,
          '0',
          'COUNT',
          String(VALUE_ITEMS_MAX),
        ])
        const pairs: Record<string, string> = {}
        for (let i = 0; i + 1 < flat.length && i < VALUE_ITEMS_MAX * 2; i += 2)
          pairs[flat[i]!] = flat[i + 1]!
        return pairs
      }
      case 'set': {
        const [, members] = await this.redis.sendCommand<[string, string[]]>([
          'SSCAN',
          full,
          '0',
          'COUNT',
          String(VALUE_ITEMS_MAX),
        ])
        return members.slice(0, VALUE_ITEMS_MAX)
      }
      default:
        return null
    }
  }
}
