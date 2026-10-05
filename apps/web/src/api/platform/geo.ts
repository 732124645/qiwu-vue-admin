import type { GeoAreaNode, GeoIpVo } from '@qiwu/shared'
import { api } from '@/core/request/http'

const BASE = '/geo/areas'

let tree: Promise<GeoAreaNode[]> | undefined

/** /api/geo/areas: the division tree and IP locations (platform/geo). */
export const geoApi = {
  /** province → city → county, fetched once per page load (static data); a failed fetch is retried next call */
  tree: () =>
    (tree ??= api.get<GeoAreaNode[]>(`${BASE}/tree`).catch((e: unknown) => {
      tree = undefined
      throw e
    })),
  /** every part null = unknown (no xdb file, a private or IPv6 address) */
  byIp: (ip: string) => api.get<GeoIpVo>(`${BASE}/by-ip`, { params: { ip } }),
}
