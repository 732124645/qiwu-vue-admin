import type {
  StorageConfigCreate,
  StorageConfigUpdate,
  StorageConfigVo,
  StorageTestVo,
} from '@qiwu/shared'
import { api } from '@/core/request/http'

const BASE = '/storage/configs'

/**
 * /api/storage/configs beside the generated list (contract storage-driver.schema.ts; see docs/design-notes.md#storage): the
 * driver-shaped detail and bodies of the config form, the connection test and the primary switch.
 */
export const storageConfigApi = {
  /** `secretKey` comes back masked */
  get: (id: number) => api.get<StorageConfigVo>(`${BASE}/${id}`),
  create: (body: StorageConfigCreate) => api.post<StorageConfigVo>(BASE, body),
  /** `secretKey` left out = the stored one stays */
  update: (id: number, body: StorageConfigUpdate) =>
    api.put<StorageConfigVo>(`${BASE}/${id}`, body),
  /** connects with the saved settings; `ok` only, a failure is never told apart */
  test: (id: number) => api.post<StorageTestVo>(`${BASE}/${id}/test`),
  setPrimary: (id: number) => api.put(`${BASE}/${id}/primary`),
}
