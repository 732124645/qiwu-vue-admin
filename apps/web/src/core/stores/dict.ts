import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { DictEntry, DictPayload } from '@qiwu/shared'
import { localized } from '@/core/i18n'
import { api } from '@/core/request/http'

export const useDictStore = defineStore('dict', () => {
  const dicts = ref<Record<string, DictPayload>>({})
  const pending = new Map<string, Promise<DictEntry[]>>()

  /** Fetches a dict once (concurrent callers share the request); cached until invalidated. */
  function load(code: string): Promise<DictEntry[]> {
    const cached = dicts.value[code]
    if (cached) return Promise.resolve(cached.entries)
    let p = pending.get(code)
    if (!p) {
      p = api
        .get<DictPayload>(`/settings/dicts/${encodeURIComponent(code)}/entries`)
        .then((d) => (dicts.value[code] = d).entries)
        .finally(() => pending.delete(code))
      pending.set(code, p)
    }
    return p
  }

  /** Reactive entries for templates; the first read triggers the lazy load. */
  function entries(code: string): DictEntry[] {
    if (!dicts.value[code]) load(code).catch(() => {})
    return dicts.value[code]?.entries ?? []
  }

  /** `label_i18n[locale]` → `label` → the raw value. */
  function label(code: string, value: unknown): string {
    const e = entries(code).find((x) => x.value === String(value))
    return e ? localized(e.labelI18n, e.label) : String(value ?? '')
  }

  /** Drops a cached dict whose version moved (any version when omitted); the next read refetches. */
  function invalidate(code: string, version?: number) {
    if (version === undefined || dicts.value[code]?.version !== version) delete dicts.value[code]
  }

  return { dicts, load, entries, label, invalidate }
})
