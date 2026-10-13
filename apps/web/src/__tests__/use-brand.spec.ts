// The product name and logo: the tenant's brand (the session's once signed in, else the host's), else
// VITE_APP_TITLE, else the translated wordmark. The default tenant sets no brand: nothing changes there.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import type { MeTenant, TenancyVo } from '@qiwu/shared'
import { tenancy } from '@/api/auth-extra'
import { hostBrand, useBrand } from '@/core/composables/use-brand'
import { i18n, setLocale } from '@/core/i18n'
import AppLogo from '@/core/layout/AppLogo.vue'
import AuthPage from '@/core/layout/AuthPage.vue'
import { setSessionHint } from '@/core/request/http'
import { createAppRouter } from '@/core/router'
import { useAuthStore } from '@/core/stores/auth'
import { me, mockApi, ok } from './mock-api'

const LOGO = '/api/storage/files/public/acme-logo.png'
const DEFAULT: MeTenant = {
  id: 1,
  code: 'default',
  name: 'seed.tenant.default',
  brandName: null,
  logoUrl: null,
  acting: false,
}
const ACME: MeTenant = {
  id: 7,
  code: 'acme',
  name: 'Acme Co',
  brandName: 'Acme Inside',
  logoUrl: LOGO,
  acting: false,
}
/** a fresh read (VITE_APP_TITLE is no reactive source) */
const brand = () => {
  const { name, title, logoUrl } = useBrand()
  return { name: name.value, title: title.value, logoUrl: logoUrl.value }
}

beforeEach(() => {
  setActivePinia(createPinia())
  hostBrand.value = null
  setLocale('en-US')
})
afterEach(() => {
  vi.unstubAllEnvs()
  setLocale('zh-CN')
})

it('brand name over VITE_APP_TITLE over the translated title; the session brand over the host one', async () => {
  const appTitle = i18n.global.t('common.app.title')
  vi.stubEnv('VITE_APP_TITLE', '')
  expect(brand()).toEqual({ name: null, title: appTitle, logoUrl: null })
  vi.stubEnv('VITE_APP_TITLE', 'Ops Console')
  expect(brand()).toEqual({ name: 'Ops Console', title: 'Ops Console', logoUrl: null })

  // before sign-in: the tenant this host is bound to, as GET /auth/tenancy answered
  mockApi({
    'GET /auth/tenancy': ok({
      enabled: true,
      tenant: { code: 'acme', name: 'Acme Co', brandName: 'Acme Portal', logoUrl: LOGO },
    } satisfies TenancyVo),
  })
  await tenancy()
  expect(brand()).toEqual({ name: 'Acme Portal', title: 'Acme Portal', logoUrl: LOGO })

  // signed in: the session's tenant, even when it sets no brand
  const auth = useAuthStore()
  auth.me = { ...me(['*']), tenant: { ...ACME, logoUrl: '/l2.png' } }
  expect(brand()).toEqual({ name: 'Acme Inside', title: 'Acme Inside', logoUrl: '/l2.png' })
  auth.me = { ...me(['*']), tenant: { ...ACME, brandName: null, logoUrl: null } }
  expect(brand()).toEqual({ name: 'Ops Console', title: 'Ops Console', logoUrl: null })
  vi.stubEnv('VITE_APP_TITLE', '')
  expect(brand()).toEqual({ name: null, title: appTitle, logoUrl: null })

  // signed out: the host's again
  auth.clear()
  expect(brand().name).toBe('Acme Portal')
})

it('the default tenant changes nothing: side bar logo and sign-in panel as with multi-tenancy off', async () => {
  vi.stubEnv('VITE_APP_TITLE', '')
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  })
  const global = { plugins: [ElementPlus, i18n, router] }
  const render = async () => {
    const logo = mount(AppLogo, { global })
    const page = mount(AuthPage, { props: { title: 'Sign in' }, global })
    await flushPromises()
    const html = [logo.html(), page.find('.auth-brand__logo').html()]
    logo.unmount()
    page.unmount()
    return html
  }
  const auth = useAuthStore()
  auth.me = me(['*'])
  const off = await render()
  expect(off[0]).toContain('<svg')
  expect(off[0]).not.toContain('<img')
  auth.me = { ...me(['*']), tenant: DEFAULT }
  expect(await render()).toEqual(off)
  auth.me = null
  expect(await render()).toEqual(off)

  // a tenant's brand: its name, and its logo on a surface tile with an empty alt (the name says it)
  auth.me = { ...me(['*']), tenant: ACME }
  const logo = mount(AppLogo, { global })
  const page = mount(AuthPage, { props: { title: 'Sign in' }, global })
  await flushPromises()
  for (const mark of [logo.find('.brand-mark--image'), page.find('.brand-mark--image')]) {
    expect(mark.find('img').attributes()).toMatchObject({ src: LOGO, alt: '' })
    expect(mark.find('svg').exists()).toBe(false)
  }
  expect(logo.attributes('aria-label')).toBe('Acme Inside')
  expect(logo.find('.app-logo__text').text()).toBe('Acme Inside')
  expect(page.find('.auth-brand__logo').text()).toBe('Acme Inside')
  logo.unmount()
  page.unmount()
})

it('the browser title follows the brand, one known after the navigation too', async () => {
  vi.stubEnv('VITE_APP_TITLE', '')
  setSessionHint(false)
  mockApi({})
  const router = createAppRouter(createMemoryHistory())
  await router.push('/login')
  const page = i18n.global.t('common.login.title')
  expect(document.title).toBe(`${page} - ${i18n.global.t('common.app.title')}`)
  hostBrand.value = { brandName: 'Acme Portal', logoUrl: null }
  await flushPromises()
  expect(document.title).toBe(`${page} - Acme Portal`)
})
