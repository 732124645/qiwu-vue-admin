import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  LoginBody,
  MePayload,
  SmsLoginBody,
  WxMpBindBody,
  WxMpLoginVo,
} from '@qiwu/shared'
import { stopRealtime } from '@/core/realtime'
import { api, setSession, toPasswordChange, type MobileTokens } from '@/core/request'
import { useCountsStore } from './counts'

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** whether the sign-in page may still try WeChat sign-in in this launch (takeWxLaunch) */
let wxOnLaunch = true

/** The signed-in user (GET /auth/me); the tokens themselves live in the request layer. */
export const useAuthStore = defineStore('auth', () => {
  const me = ref<MePayload | null>(null)
  const perms = computed(() => new Set(me.value?.perms))
  /** An initial or expired password: the server allows nothing but the change and sign-out until then. */
  const passwordChangeDue = computed(
    () => !!me.value && (me.value.flags.mustChangePassword || me.value.flags.passwordExpired),
  )

  /** Any of the permission points (`<domain>.<resource>.<verb>`); root holds `*`. */
  const hasPerm = (perm: string | string[]) =>
    perms.value.has('*') || [perm].flat().some((p) => perms.value.has(p))

  /**
   * A `mobile` session (the refresh token comes back in the body), kept signed in as phone apps
   * are (7-day absolute cap still ends it; see docs/design-notes.md#auth-sessions).
   */
  async function signIn(url: string, body: LoginBody | SmsLoginBody) {
    start(
      await api.post<MobileTokens>(
        url,
        { ...body, clientId: 'mobile', keepSignedIn: true },
        { silent: true },
      ),
    )
  }

  function start(tokens: MobileTokens) {
    me.value = null
    useCountsStore().reset()
    // a new user never inherits the previous one's socket (the tab page's show opens theirs)
    stopRealtime()
    setSession(tokens)
  }

  /**
   * WeChat sign-in (mp-weixin; always a kept `mobile` session): a fresh `uni.login` code. A bound
   * account is signed in (null); an unbound one answers its one-time bind ticket. WeChat sign-in switched off
   * is a 404 ApiError; every error is the caller's.
   */
  async function wxLogin(): Promise<string | null> {
    const code = await new Promise<string>((resolve, reject) =>
      uni.login({ provider: 'weixin', success: (r) => resolve(r.code), fail: reject }),
    )
    const out = await api.post<WxMpLoginVo>('/auth/wx-mp/login', { code }, { silent: true })
    if ('bindTicket' in out) return out.bindTicket
    start(out.tokens as MobileTokens)
    return null
  }

  /**
   * Binds this WeChat account to the account the proof (password or SMS code) belongs to, then signs in. A
   * ticket is spent by every try, so each try asks WeChat for a new one (signed in at once if the account was
   * bound meanwhile).
   */
  async function wxBind(proof: DistributiveOmit<WxMpBindBody, 'ticket'>) {
    const ticket = await wxLogin()
    if (ticket !== null)
      start(await api.post<MobileTokens>('/auth/wx-mp/bind', { ...proof, ticket }, { silent: true }))
  }

  async function fetchMe() {
    me.value = await api.get<MePayload>('/auth/me')
    if (passwordChangeDue.value) toPasswordChange()
  }

  async function logout() {
    try {
      await api.post('/auth/logout', undefined, { silent: true })
    } catch {
      // the session is gone either way
    }
    me.value = null
    useCountsStore().reset()
    stopRealtime()
    setSession(null)
    wxOnLaunch = false
  }

  return {
    me,
    perms,
    passwordChangeDue,
    hasPerm,
    login: (body: LoginBody) => signIn('/auth/login', body),
    smsLogin: (body: SmsLoginBody) => signIn('/auth/sms/login', body),
    wxLogin,
    wxBind,
    fetchMe,
    logout,
  }
})

/**
 * The sign-in page tries WeChat sign-in (mp-weixin) once per app launch: true only on the first call, and never
 * after a sign-out (the page shows its forms instead of signing the same WeChat account straight back in, also
 * when a stored session skipped the page at launch).
 */
export function takeWxLaunch(): boolean {
  const first = wxOnLaunch
  wxOnLaunch = false
  return first
}

/**
 * Permission check for scripts and templates (no directives on mp-weixin; `<QwPerm>` wraps it for markup).
 * Display only: the server enforces every permission.
 */
export const hasPerm = (perm: string | string[]) => useAuthStore().hasPerm(perm)
