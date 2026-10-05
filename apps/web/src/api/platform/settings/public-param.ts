import type { PublicParam } from '@qiwu/shared'
import { api } from '@/core/request/http'

export const publicParamApi = {
  get: (key: string) =>
    api.get<PublicParam>(`/settings/params/public/${encodeURIComponent(key)}`, { silent: true }),
}
