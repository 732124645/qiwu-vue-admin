import { z } from 'zod'
import { fieldDomains } from '../../validation/zod-i18n.js'

/**
 * Areas and IP location (platform/geo), `/api/geo/areas`. Field labels `field.geo.area.<prop>`.
 *
 * - `GET /tree` (any signed-in user: `AreaCascader`): the whole province → city → county tree of
 *   `@vant/area-data` (names in Chinese only: the data set has no other language)
 * - `GET /by-ip?ip=` (`browse`): `geoByIpQuery` → `geoIpVo` (ip2region v4 xdb; every part null = unknown,
 *   also when the xdb file is missing or the address is IPv6 / private)
 */

export const geoPerms = { browse: 'geo.area.browse' } as const

export interface GeoAreaNode {
  /** 6-digit division code, e.g. `110101` */
  code: string
  name: string
  /** absent on counties (leaves) */
  children?: GeoAreaNode[]
}

export const geoAreaNodeVo: z.ZodType<GeoAreaNode> = z.object({
  code: z.string(),
  name: z.string(),
  get children() {
    return z.array(geoAreaNodeVo).optional()
  },
})

export const geoByIpQuery = z
  .object({ ip: z.union([z.ipv4(), z.ipv6()]) })
  .register(fieldDomains, { domain: 'geo.area' })
export type GeoByIpQuery = z.infer<typeof geoByIpQuery>

export const geoIpVo = z.object({
  ip: z.string(),
  country: z.string().nullable(),
  province: z.string().nullable(),
  city: z.string().nullable(),
  isp: z.string().nullable(),
})
export type GeoIpVo = z.infer<typeof geoIpVo>
