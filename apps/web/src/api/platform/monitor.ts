import type {
  CacheClearVo,
  CacheKeysVo,
  CacheNamespaceVo,
  CacheValueVo,
  MonitorMysqlVo,
  MonitorRedisVo,
  MonitorServerVo,
} from '@qiwu/shared'
import { api } from '@/core/request/http'

const BASE = '/monitor'

/** /api/monitor/*: the monitoring dashboards. `silent`: no error toast (polls retry quietly). */
export const monitorApi = {
  server: (silent = false) => api.get<MonitorServerVo>(`${BASE}/server`, { silent }),
  redis: () => api.get<MonitorRedisVo>(`${BASE}/redis`),
  /** the registered namespaces (core/redis/cache-namespaces.ts) */
  cacheNamespaces: () => api.get<CacheNamespaceVo[]>(`${BASE}/cache/namespaces`),
  /** keys of a namespace, without the global prefix; at most CACHE_SCAN_MAX (`truncated`) */
  cacheKeys: (ns: string) => api.get<CacheKeysVo>(`${BASE}/cache/keys`, { params: { ns } }),
  cacheValue: (key: string) => api.get<CacheValueVo>(`${BASE}/cache/value`, { params: { key } }),
  /** deletes one key or every key of a (clearable) namespace */
  cacheClear: (target: { ns: string } | { key: string }) =>
    api.delete<CacheClearVo>(`${BASE}/cache/keys`, { params: target }),
  /** deletes the keys of every clearable namespace */
  cacheClearAll: () => api.delete<CacheClearVo>(`${BASE}/cache/all-registered`),
  mysql: () => api.get<MonitorMysqlVo>(`${BASE}/mysql`),
}
