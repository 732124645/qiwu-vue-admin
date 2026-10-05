// vitest setup: no uni runtime in Node, so a stand-in for the uni APIs the core uses (storage in memory; the
// network, toast and navigation calls are mocks each spec drives or inspects).
import { vi } from 'vitest'

const storage = new Map<string, unknown>()
vi.stubGlobal('uni', {
  getStorageSync: (key: string) => storage.get(key) ?? '',
  setStorageSync: (key: string, value: unknown) => void storage.set(key, value),
  removeStorageSync: (key: string) => void storage.delete(key),
  getLocale: () => 'zh-Hans',
  setLocale: vi.fn(),
  request: vi.fn(),
  login: vi.fn(),
  uploadFile: vi.fn(),
  showToast: vi.fn(),
  // navigation completes later, as on a device
  reLaunch: vi.fn((o: { complete?: () => void }) => setTimeout(() => o.complete?.())),
})
vi.stubGlobal('getCurrentPages', () => [])
