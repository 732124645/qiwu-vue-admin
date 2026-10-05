import { loadavg, uptime } from 'node:os'
import { Inject, Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import {
  MYSQL_STATUS_KEYS,
  MYSQL_VARIABLE_KEYS,
  type MonitorMysqlVo,
  type MonitorRedisVo,
  type MonitorServerVo,
  REDIS_INFO_SECTIONS,
} from '@qiwu/shared'
import { cpu, currentLoad, fsSize, mem, osInfo } from 'systeminformation'
import type { DataSource } from 'typeorm'
import { AppConfigService } from '../../../core/config/config.module.js'
import { REDIS, type Redis } from '../../../core/redis/redis.module.js'

/** INFO fields never shown: file system paths of the Redis host. */
const REDIS_HIDDEN = new Set(['executable', 'config_file'])

const round = (n: number) => Math.round(n * 100) / 100
const pct = (part: number, whole: number) => (whole > 0 ? round((part / whole) * 100) : 0)

/** `INFO` text → section (lower case) → field → value. */
function parseInfo(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  let section: Record<string, string> | undefined
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('# ')) out[line.slice(2).trim().toLowerCase()] = section = {}
    else if (section && line.includes(':')) {
      const at = line.indexOf(':')
      section[line.slice(0, at)] = line.slice(at + 1)
    }
  }
  return out
}

/** `calls=3,usec=12,usec_per_call=4.00` → `{ calls: '3', … }` */
const fieldsOf = (value: string) =>
  Object.fromEntries(value.split(',').map((kv) => kv.split('=') as [string, string]))

/**
 * The read-only monitor pages: this host and process (systeminformation), the Redis
 * instance through the commands the app's ACL user may run (INFO, no CONFIG / KEYS), and a whitelist
 * of MySQL status and variables with the app's connection pool.
 */
@Injectable()
export class MonitorService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly cfg: AppConfigService,
  ) {}

  async server(): Promise<MonitorServerVo> {
    const [load, cpuInfo, memory, disks, os] = await Promise.all([
      currentLoad(),
      cpu(),
      mem(),
      fsSize(),
      osInfo(),
    ])
    const m = process.memoryUsage()
    return {
      cpu: {
        model: `${cpuInfo.manufacturer} ${cpuInfo.brand}`.trim(),
        cores: cpuInfo.cores,
        usage: round(load.currentLoad),
        loadAvg: loadavg().map(round),
      },
      // `active` = what processes hold; `used` also counts the file cache the OS gives back on demand
      mem: { total: memory.total, used: memory.active, usage: pct(memory.active, memory.total) },
      disks: disks
        .filter((d) => d.size > 0)
        .map((d) => ({
          mount: d.mount,
          fs: d.fs,
          type: d.type,
          size: d.size,
          used: d.used,
          usage: pct(d.used, d.size),
        })),
      os: {
        platform: os.platform,
        distro: os.distro,
        release: os.release,
        arch: os.arch,
        hostname: os.hostname,
        uptime: Math.round(uptime()),
      },
      node: { version: process.versions.node, v8: process.versions.v8 },
      process: {
        pid: process.pid,
        uptime: Math.round(process.uptime()),
        rss: m.rss,
        heapTotal: m.heapTotal,
        heapUsed: m.heapUsed,
        external: m.external,
      },
    }
  }

  /** One `INFO` of the whitelisted sections + commandstats + keyspace (the instance is shared: own db only). */
  async redisInfo(): Promise<MonitorRedisVo> {
    const text = await this.redis.sendCommand<string>([
      'INFO',
      ...REDIS_INFO_SECTIONS,
      'commandstats',
      'keyspace',
    ])
    const all = parseInfo(String(text))
    const info: MonitorRedisVo['info'] = {}
    for (const s of REDIS_INFO_SECTIONS)
      if (all[s])
        info[s] = Object.fromEntries(Object.entries(all[s]).filter(([k]) => !REDIS_HIDDEN.has(k)))
    const commandStats = Object.entries(all.commandstats ?? {})
      .map(([name, value]) => {
        const f = fieldsOf(value)
        return {
          command: name.replace(/^cmdstat_/, ''),
          calls: Number(f.calls) || 0,
          usec: Number(f.usec) || 0,
          usecPerCall: Number(f.usec_per_call) || 0,
        }
      })
      .sort((a, b) => b.calls - a.calls || a.command.localeCompare(b.command))
    const db = this.cfg.get('REDIS_DB')
    const own = fieldsOf(all.keyspace?.[`db${db}`] ?? '')
    return {
      info,
      commandStats,
      keyspace: {
        db,
        keys: Number(own.keys) || 0,
        expires: Number(own.expires) || 0,
        avgTtl: Number(own.avg_ttl) || 0,
      },
    }
  }

  /** The whitelisted `SHOW GLOBAL STATUS` / `VARIABLES` rows (parameterized names) and the pool. */
  async mysql(): Promise<MonitorMysqlVo> {
    type Row = { Variable_name: string; Value: string }
    const [status, variables] = await Promise.all([
      this.ds.query<Row[]>('SHOW GLOBAL STATUS WHERE Variable_name IN (?)', [MYSQL_STATUS_KEYS]),
      this.ds.query<Row[]>('SHOW GLOBAL VARIABLES WHERE Variable_name IN (?)', [
        MYSQL_VARIABLE_KEYS,
      ]),
    ])
    return {
      status: Object.fromEntries(
        status
          .map((r) => [r.Variable_name, Number(r.Value)] as const)
          .filter(([, v]) => Number.isFinite(v)),
      ),
      variables: Object.fromEntries(variables.map((r) => [r.Variable_name, r.Value])),
      pool: this.pool(),
    }
  }

  /**
   * mysql2's pool counts. They are private fields of mysql2's Pool (`config.connectionLimit`,
   * `_allConnections` / `_freeConnections` / `_connectionQueue`); a driver update that renames them
   * turns the card's pool part into null, nothing breaks.
   */
  private pool(): MonitorMysqlVo['pool'] {
    const p = (this.ds.driver as unknown as { pool?: Record<string, unknown> }).pool
    const len = (v: unknown) => (v as { length?: unknown } | undefined)?.length
    const limit = (p?.config as { connectionLimit?: unknown } | undefined)?.connectionLimit
    const [total, idle, queued] = [
      len(p?._allConnections),
      len(p?._freeConnections),
      len(p?._connectionQueue),
    ]
    return typeof limit === 'number' &&
      typeof total === 'number' &&
      typeof idle === 'number' &&
      typeof queued === 'number'
      ? { limit, total, idle, queued }
      : null
  }
}
