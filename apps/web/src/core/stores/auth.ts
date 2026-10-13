import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useStorage } from '@vueuse/core'
import {
  DEFAULT_TENANT_ID,
  type LoginBody,
  type MePayload,
  type SmsLoginBody,
  type TokenPayload,
} from '@qiwu/shared'
import { sessionBrand } from '@/core/composables/use-brand'
import { useTablePrefsStore } from '@/core/composables/use-table-prefs'
import {
  accessToken,
  api,
  refreshAccessToken,
  refreshSettled,
  resetSession,
  sessionEnd,
  setSessionHint,
  tenantExpect,
} from '@/core/request/http'
import { useMenuStore } from './menu'
import { useNotifyStore } from './notify'

export const useAuthStore = defineStore('auth', () => {
  const me = ref<MePayload | null>(null)
  const perms = computed(() => new Set(me.value?.perms))
  const roles = computed(() => me.value?.roles ?? [])
  const flags = computed(() => me.value?.flags ?? null)
  /** `/me` flags: only /password-change and sign-out are allowed until the password is changed. */
  const mustChangePassword = computed(
    () => !!flags.value && (flags.value.mustChangePassword || flags.value.passwordExpired),
  )

  /**
   * The session's data tenant changed under a loaded `/me` (a platform user entering a tenant, another tab
   * signing in elsewhere on the shared refresh cookie): the whole page reloads. A `/me` without `tenant`
   * (multi-tenancy off) is the default tenant; signing out or in between (no `/me`) is no change.
   */
  watch(
    () => me.value && (me.value.tenant?.id ?? DEFAULT_TENANT_ID),
    (id, prev) => {
      if (id && prev && id !== prev) location.reload()
    },
    { flush: 'sync' },
  )
  /** `/me.tenant`: the session's data tenant, only while multi-tenancy is on */
  const tenant = computed(() => me.value?.tenant ?? null)
  // the tenant the requests expect (`X-Tenant-Expect`) and the brand shown follow `/me`
  watch(
    me,
    (m) => {
      tenantExpect.value = m?.tenant?.id ?? null
      sessionBrand.value = m ? (m.tenant ?? null) : undefined
    },
    { flush: 'sync', immediate: true },
  )

  /** Any of the permission points (`<domain>.<resource>.<verb>`); root holds `*`. */
  const hasPerm = (perm: string | string[]) =>
    perms.value.has('*') || [perm].flat().some((p) => perms.value.has(p))
  /**
   * The platform root: `*` belongs to the builtin root role, which lives in the default tenant alone (still
   * `*` while working inside another tenant). Pages over every tenant's data offer it their tenant filters.
   */
  const platformRoot = computed(() => perms.value.has('*'))

  /**
   * Lock screen (see docs/design-notes.md#layering): the page to return to while locked, null when unlocked. In localStorage, so
   * a reload stays locked (other tabs on their next navigation); the router guard sends every signed-in
   * route to /lock. Signing in or out unlocks.
   */
  const lockedAt = useStorage<string | null>('qw.auth.lock', null)
  const locked = computed(() => !!lockedAt.value)
  const lock = (returnTo: string) => (lockedAt.value = returnTo)
  /** After POST /auth/verify-password succeeded: where to go back to. */
  function unlock() {
    const back = lockedAt.value || '/'
    lockedAt.value = null
    return back
  }

  /** Drops the session state; a refresh or replay still in flight for it no longer applies. */
  function clear() {
    resetSession()
    me.value = null
    lockedAt.value = null
    useMenuStore().reset()
    useNotifyStore().reset()
    useTablePrefsStore().clear()
  }

  async function signIn(url: string, body: LoginBody | SmsLoginBody) {
    await refreshSettled()
    const token = await api.post<TokenPayload>(url, body, { silent: true })
    clear()
    sessionEnd.value = null
    accessToken.value = token.accessToken
    setSessionHint(true)
  }
  const login = (body: LoginBody) => signIn('/auth/login', body)
  const smsLogin = (body: SmsLoginBody) => signIn('/auth/sms/login', body)

  const refresh = () => refreshAccessToken()

  async function fetchMe() {
    me.value = await api.get<MePayload>('/auth/me')
  }

  async function logout() {
    await refreshSettled()
    try {
      await api.post('/auth/logout', null, { silent: true })
    } catch {
      // the session is gone either way
    }
    setSessionHint(false)
    clear()
    sessionEnd.value = null
  }

  return {
    accessToken,
    me,
    perms,
    roles,
    flags,
    tenant,
    mustChangePassword,
    hasPerm,
    platformRoot,
    locked,
    lock,
    unlock,
    clear,
    login,
    smsLogin,
    refresh,
    fetchMe,
    logout,
  }
})
