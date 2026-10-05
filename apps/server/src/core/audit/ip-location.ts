import { BlockList, isIP } from 'node:net'
import { Logger } from '@nestjs/common'
import type { GeoIpVo } from '@qiwu/shared'
import { IPv4, loadContentFromFile, newWithBuffer, type Searcher } from 'ip2region.js'
import { plainIp } from '../auth/auth-params.js'
import { ip2regionFile } from '../paths.js'

export type IpPlace = Omit<GeoIpVo, 'ip'>

const UNKNOWN: IpPlace = { country: null, province: null, city: null, isp: null }

/** Private, loopback, link-local, CGNAT and "this network" ranges: no place to look up. */
const LOCAL = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const)
  LOCAL.addSubnet(net, bits, 'ipv4')

/** An xdb region `中国|广东省|深圳市|电信|CN` (country|province|city|ISP|ISO); `0` or blank = unknown. */
export function placeOf(region: string): IpPlace {
  const [country, province, city, isp] = region
    .split('|')
    .map((part) => (part && part !== '0' ? part : null))
  return {
    country: country ?? null,
    province: province ?? null,
    city: city ?? null,
    isp: isp ?? null,
  }
}

/** `中国 广东省 深圳市` for the log/session `location` columns (128); null when unknown. */
export function locationText(p: IpPlace): string | null {
  const parts = [p.country, p.province, p.city].filter(
    (part, i, all): part is string => !!part && part !== all[i - 1],
  )
  return parts.join(' ').slice(0, 128) || null
}

/**
 * IPv4 → place from the ip2region xdb, loaded whole into memory on first use (≈ 11 MB;
 * a buffer searcher is safe for concurrent lookups). A missing or unreadable file warns once and every
 * lookup answers unknown until the next start; IPv6 and private addresses are always unknown.
 */
export class IpLocator {
  private readonly logger = new Logger(IpLocator.name)
  private searcher?: Promise<Searcher | null>

  constructor(private readonly file: () => string = ip2regionFile) {}

  async locate(ip: string | null | undefined): Promise<IpPlace> {
    const v4 = plainIp(ip ?? '')
    if (isIP(v4) !== 4 || LOCAL.check(v4, 'ipv4')) return UNKNOWN
    const searcher = await (this.searcher ??= this.load())
    try {
      return searcher ? placeOf(await searcher.search(v4)) : UNKNOWN
    } catch {
      return UNKNOWN
    }
  }

  async location(ip: string | null | undefined): Promise<string | null> {
    return locationText(await this.locate(ip))
  }

  private async load(): Promise<Searcher | null> {
    const file = this.file()
    try {
      const searcher = newWithBuffer(IPv4, loadContentFromFile(file))
      // a truncated or foreign file fails here once instead of on every lookup
      await searcher.search('1.1.1.1')
      return searcher
    } catch (e) {
      this.logger.warn(
        `IP locations stay empty: cannot read ${file} (${(e as Error).message}); run node scripts/fetch-ip2region.mjs`,
      )
      return null
    }
  }
}

/** The app's one locator (sign-in/action logs, sessions, GET /api/geo/areas/by-ip). */
export const ipLocator = new IpLocator()
