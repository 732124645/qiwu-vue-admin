// Multi-tenancy on the app (see docs/design-notes.md#tenancy): the sign-in pages' tenant code and the
// session tenant's brand.
import { computed, reactive, ref } from 'vue'
import {
  DEFAULT_TENANT_CODE,
  loginBody,
  tenantCode,
  type MePayload,
  type TenancyVo,
  type ValidationIssue,
} from '@qiwu/shared'
import { fieldErrors, t, tx } from './i18n'
import { api, assetUrl } from './request'

/** The code of the last sign-in on this device, as the remembered username. */
export const TENANT_KEY = 'qw.login.tenant'

const codeField = loginBody.pick({ tenantCode: true })

/**
 * The sign-in pages' tenant code: shown only while multi-tenancy is on and the API's host is bound to no
 * tenant (`GET /auth/tenancy`). App and mini program always see it on then (their API base is fixed at build
 * time); H5 on a bound host does not, as the web. Blank = the default tenant. Prefilled with the kept code.
 * `read()` before each request: null while the code is malformed (the field shows why), else the body's
 * `{tenantCode}` (nothing while hidden or blank); it waits for `/auth/tenancy`, so a request sent before that
 * answer still carries the kept code. An unanswered `/auth/tenancy` is not taken for "off": `read()` asks
 * again and, failing again, throws the request's error for the page to show. `remember(keep)` once signed in.
 */
export function useTenantCode() {
  const shown = ref(false)
  const text = ref('')
  const issues = ref<ValidationIssue[]>([])
  const error = computed(() => fieldErrors(loginBody, issues.value).tenantCode ?? '')

  const load = () =>
    api.get<TenancyVo>('/auth/tenancy', undefined, { silent: true }).then(({ enabled, tenant }) => {
      shown.value = enabled && !tenant
      const saved: unknown = uni.getStorageSync(TENANT_KEY)
      if (shown.value && typeof saved === 'string') text.value = saved
    })
  let ready = load()
  // read() retries it
  ready.catch(() => {})

  async function read(): Promise<{ tenantCode?: string } | null> {
    await ready.catch(() => (ready = load()))
    if (!shown.value) return {}
    const parsed = codeField.safeParse({ tenantCode: text.value.trim() || undefined })
    issues.value = parsed.error?.issues ?? []
    if (!parsed.success) return null
    return parsed.data.tenantCode ? { tenantCode: parsed.data.tenantCode } : {}
  }

  /** `keep`: offer this sign-in's code next time (blank forgets it); otherwise forget the kept one. */
  function remember(keep: boolean) {
    if (!shown.value) return
    const code = tenantCode.safeParse(text.value).data
    if (keep && code) uni.setStorageSync(TENANT_KEY, code)
    else uni.removeStorageSync(TENANT_KEY)
  }

  return reactive({ shown, text, error, read, remember })
}
export type TenantCode = ReturnType<typeof useTenantCode>

/**
 * The name and logo the home bar and the "Me" page show: the tenant's brand name, else a tenant's own name
 * (the default tenant: the app's), and its logo ('' = the brand mark). Multi-tenancy off (`/me` without
 * `tenant`): the app's, as before.
 */
export function tenantBrand(me: MePayload | null): { name: string; logo: string } {
  const tenant = me?.tenant
  const own = tenant && tenant.code !== DEFAULT_TENANT_CODE ? tx(tenant.name) : ''
  return {
    name: tenant?.brandName || own || t('common.app.name'),
    logo: tenant?.logoUrl ? assetUrl(tenant.logoUrl) : '',
  }
}
