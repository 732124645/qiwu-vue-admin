import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useStorage } from '@vueuse/core'
import type { LoginBody, MePayload, SmsLoginBody, TokenPayload } from '@qiwu/shared'
import { useTablePrefsStore } from '@/core/composables/use-table-prefs'
import {
  accessToken,
  api,
  refreshAccessToken,
  refreshSettled,
  resetSession,
  setSessionHint,
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

  /** Any of the permission points (`<domain>.<resource>.<verb>`); root holds `*`. */
  const hasPerm = (perm: string | string[]) =>
    perms.value.has('*') || [perm].flat().some((p) => perms.value.has(p))

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
  }

  return {
    accessToken,
    me,
    perms,
    roles,
    flags,
    mustChangePassword,
    hasPerm,
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
