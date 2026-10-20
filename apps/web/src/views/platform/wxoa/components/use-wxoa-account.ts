import { computed, ref } from 'vue'
import type { WxoaAccountOption } from '@qiwu/shared'
import { wxoaAccountApi } from '@/api/platform/wxoa/account'
import { useAuthStore } from '@/core/stores/auth'

// One state for every wxoa page: switching the account on one page switches it on all of them.
const options = ref<WxoaAccountOption[]>([])
const loading = ref(false)
const loaded = ref(false)
/** the last load failed (network, 5xx); the list loaded before for the same user stays */
const failed = ref(false)
/** the stored choice; may name an account that is gone or disabled by now */
const chosen = ref<number | null>(null)
/** the user the options were loaded for */
let owner: number | null = null
let pending: Promise<void> | null = null

const storageKey = (userId: number) => `qw.wxoa.account.${userId}`

function readChoice(userId: number): number | null {
  try {
    const id = Number(localStorage.getItem(storageKey(userId)))
    return Number.isSafeInteger(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

/**
 * The official account the wxoa pages act on. `options` = `GET /wxoa/accounts/options` (any
 * `wxoa.*.browse` reads it), disabled accounts included but never chosen; `accountId` = the user's
 * choice (kept per user in localStorage) while it is still an enabled account, else the first enabled
 * one, null when there is none (`empty` once loaded: the page points to the account page). `load()`
 * reloads (one request at a time); a failed reload keeps the user's last list and sets `failed`.
 */
export function useWxoaAccount() {
  const auth = useAuthStore()
  const userId = () => auth.me?.user.id ?? 0

  function load(): Promise<void> {
    pending ??= (async () => {
      const user = userId()
      if (owner !== user) options.value = []
      loading.value = true
      try {
        options.value = await wxoaAccountApi.options()
        failed.value = false
      } catch {
        // the request layer toasts what it should (403, 5xx); the list of this user stays
        failed.value = true
      } finally {
        owner = user
        chosen.value = readChoice(user)
        loaded.value = true
        loading.value = false
        pending = null
      }
    })()
    return pending
  }

  const usable = computed(() => options.value.filter((o) => o.enabled))
  const accountId = computed<number | null>({
    get: () => usable.value.find((o) => o.id === chosen.value)?.id ?? usable.value[0]?.id ?? null,
    set: (id) => {
      chosen.value = id
      try {
        if (id == null) localStorage.removeItem(storageKey(userId()))
        else localStorage.setItem(storageKey(userId()), String(id))
      } catch {
        // storage blocked: the choice lasts until the page reloads
      }
    },
  })
  const account = computed(() => options.value.find((o) => o.id === accountId.value) ?? null)
  const empty = computed(
    () => loaded.value && !loading.value && !failed.value && !usable.value.length,
  )

  return { options, accountId, account, loading, failed, empty, load }
}
