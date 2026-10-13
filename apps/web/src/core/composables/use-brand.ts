import { computed, ref } from 'vue'
import type { MeTenant } from '@qiwu/shared'
import { i18n } from '@/core/i18n'

type Brand = Pick<MeTenant, 'brandName' | 'logoUrl'>

// Plain refs, no store import: the router reads the title while its own module is still loading.
/**
 * The signed-in session's tenant (`/me.tenant`; null while multi-tenancy is off), undefined while signed
 * out. Kept by the auth store.
 */
export const sessionBrand = ref<Brand | null | undefined>()
/** The tenant this host is bound to, as `GET /auth/tenancy` answered on a sign-in page (null: none). */
export const hostBrand = ref<Brand | null>(null)

const brandTenant = () => (sessionBrand.value === undefined ? hostBrand.value : sessionBrand.value)

/** The product name shown: the tenant's brand name, else `VITE_APP_TITLE`; null = the translated wordmark. */
export const brandName = (): string | null =>
  brandTenant()?.brandName || import.meta.env.VITE_APP_TITLE || null

/** The browser title and accessible name: the brand name, else the translated app title. */
export const brandTitle = (): string => brandName() || i18n.global.t('common.app.title')

/**
 * The brand of the logo places (side bar, sign-in and lock pages) and the browser title: the tenant's
 * (`brandName`, `logoUrl`) when it set one. The default tenant sets none, so nothing changes there.
 */
export function useBrand() {
  return {
    name: computed(brandName),
    title: computed(brandTitle),
    logoUrl: computed(() => brandTenant()?.logoUrl || null),
  }
}
