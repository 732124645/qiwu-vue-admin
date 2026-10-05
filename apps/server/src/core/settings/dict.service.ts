import { Inject, Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import type { DictEntry, DictPayload, I18nText } from '@qiwu/shared'
import type { DataSource } from 'typeorm'
import { keyPart, redisKey } from '../redis/cache-namespaces.js'
import { REDIS, type Redis } from '../redis/redis.module.js'

/** Safety net for changes made outside the settings API (db:seed, SQL); writes invalidate at once. */
export const SETTINGS_CACHE_TTL_SEC = 3600

/** SET KEYS[1] only while KEYS[2] (the version) still holds ARGV[1], the one read before the load. */
const SET_IF_VERSION = `if (redis.call('GET', KEYS[2]) or '') == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]) return 1 end return 0`

/**
 * Read-through with version-checked fills (dicts and params): writers commit, then bump `verKey` and
 * drop `key`. The version is read before the load and the fill is stored only if it is unchanged, so
 * a load that may predate a write (the version moved meanwhile) never lands in the cache after the
 * write's drop; that caller loads again, uncached. `load(version)` → null = nothing to cache.
 */
export async function readThrough<T>(
  redis: Redis,
  key: string,
  verKey: string,
  load: (version: number) => Promise<T | null>,
): Promise<T | null> {
  const hit = await redis.get(key)
  if (hit) return JSON.parse(hit) as T
  const ver = (await redis.get(verKey)) ?? ''
  const value = await load(Number(ver))
  if (value === null) return null
  const stored = await redis.eval(SET_IF_VERSION, {
    keys: [key, verKey],
    arguments: [ver, JSON.stringify(value), String(SETTINGS_CACHE_TTL_SEC)],
  })
  return stored === 1 ? value : load(Number((await redis.get(verKey)) ?? 0))
}

/** Cached values an `invalidate` transaction dropped: its replies alternate INCR (version), DEL/UNLINK. */
export const droppedBy = (replies: unknown[]): number =>
  replies.reduce<number>((n, r, i) => (i % 2 ? n + Number(r) : n), 0)

interface EntryRow {
  value: string
  label: string
  label_i18n: I18nText | null
  tag_type: string | null
  css_class: string | null
  is_default: number
  sort_no: number
}

/**
 * Dictionary reads (see docs/design-notes.md#i18n) through the Redis `dict:` cache: `dict:entries:{code}` holds the payload,
 * `dict:ver:{code}` the version that `invalidate` bumps (the settings pages' writes); fills are
 * version-checked (`readThrough`). Core, because Excel and notifications render dict labels too.
 */
@Injectable()
export class DictService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Enabled entries of an enabled dict in `sort_no` order; null = no such (enabled) dict. */
  async entries(code: string): Promise<DictPayload | null> {
    return readThrough(
      this.redis,
      redisKey('dict', 'entries', code),
      redisKey('dictVer', code),
      async (version) => {
        const [dict] = await this.ds.query<{ enabled: number }[]>(
          'SELECT enabled FROM cfg_dict WHERE code = ? AND deleted_at IS NULL',
          [code],
        )
        if (!dict || Number(dict.enabled) !== 1) return null
        const rows = await this.ds.query<EntryRow[]>(
          `SELECT value, label, label_i18n, tag_type, css_class, is_default, sort_no
             FROM cfg_dict_entry
            WHERE dict_code = ? AND enabled = 1 AND deleted_at IS NULL
            ORDER BY sort_no, id`,
          [code],
        )
        return {
          version,
          entries: rows.map((r): DictEntry => ({
            value: r.value,
            label: r.label,
            labelI18n: r.label_i18n,
            tagType: r.tag_type,
            cssClass: r.css_class,
            isDefault: Number(r.is_default) === 1,
            sortNo: r.sort_no,
          })),
        }
      },
    )
  }

  /**
   * After any write to the dicts `codes` or their entries (after the commit), or a cache clear (the
   * cache monitor): new versions, cached entries dropped; returns how many were cached.
   */
  async invalidate(...codes: string[]): Promise<number> {
    if (!codes.length) return 0
    const tx = this.redis.multi()
    for (const code of new Set(codes))
      tx.incr(redisKey('dictVer', code)).del(redisKey('dict', 'entries', code))
    return droppedBy(await tx.exec())
  }

  /**
   * Every dict of the table and every cached one (the settings page's "refresh cache", e.g. after
   * db:seed or SQL; the cache monitor's clear).
   */
  async invalidateAll(): Promise<number> {
    // qw:include-deleted a deleted dict's entries may still be cached
    const rows = await this.ds.query<{ code: string }[]>('SELECT code FROM cfg_dict')
    const codes = new Set(rows.map((r) => r.code))
    const head = redisKey('dict', 'entries', '')
    for await (const found of this.redis.scanIterator({ MATCH: `${head}*`, COUNT: 500 }))
      for (const k of found) {
        const code = keyPart(k.slice(head.length))
        if (code !== undefined) codes.add(code)
      }
    return this.invalidate(...codes)
  }
}
