import { computed } from 'vue'
import { defineStore } from 'pinia'
import { LOCALES, type Locale } from '@qiwu/shared'
import { profileApi } from '@/api/platform/iam/profile'
import { currentLocale, setLocale } from '@/core/i18n'
import { useAuthStore } from './auth'

export const useLocaleStore = defineStore('locale', () => {
  const locale = computed(currentLocale)
  // account saves run one after another: quick switches never let an earlier PUT land last
  let saving: Promise<unknown> = Promise.resolve()
  /**
   * Switches the app language; signed in, also the account's (PUT /api/iam/profile/locale, the
   * server's language for this user where a request names none, e.g. notifications; see docs/design-notes.md#layering). Silent: the switch
   * applies here whatever the server says. This browser keeps its own choice (localStorage).
   */
  function set(l: Locale) {
    setLocale(l)
    const auth = useAuthStore()
    if (auth.me && !auth.mustChangePassword)
      saving = saving.then(() => profileApi.setLocale(l)).catch(() => undefined)
  }
  return { locale, locales: LOCALES, set }
})
