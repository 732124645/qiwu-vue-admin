// A platform user working inside another tenant: the banner above the layout (the only way back), the
// lock screen's hint, and the tab's tenant sent with every request (`X-Tenant-Expect`, 409 → reload).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import type { MeTenant } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import TenantBanner from '@/core/layout/TenantBanner.vue'
import { accessToken, api } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import { useTagsStore } from '@/core/stores/tags'
import LockView from '@/views/lock/index.vue'
import { fail, me, mockApi, ok } from './mock-api'

const tenant = (acting: boolean): MeTenant => ({
  id: 7,
  code: 'acme',
  name: 'Acme Co',
  brandName: null,
  logoUrl: null,
  acting,
})

let wrapper: VueWrapper | undefined
const replace = vi.fn<(url: string | URL) => void>()
beforeEach(() => {
  setActivePinia(createPinia())
  accessToken.value = 'banner-test'
  setLocale('en-US')
  replace.mockClear()
  vi.spyOn(window.location, 'replace').mockImplementation(replace)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
  setLocale('zh-CN')
})

const banner = () => (wrapper = mount(TenantBanner, { global: { plugins: [ElementPlus, i18n] } }))

describe('tenant banner', () => {
  it('renders nothing while multi-tenancy is off or the session works in its own tenant', async () => {
    const auth = useAuthStore()
    auth.me = me(['*'])
    banner()
    expect(wrapper!.find('.tenant-banner').exists()).toBe(false)
    auth.me = { ...me(['*']), tenant: tenant(false) }
    await flushPromises()
    expect(wrapper!.find('.tenant-banner').exists()).toBe(false)
  })

  it('while acting: names the tenant; leaving calls leave, resets the tags, then reloads the whole page', async () => {
    const calls = mockApi({ 'POST /iam/tenants/leave': ok(null) })
    useAuthStore().me = { ...me(['*']), tenant: tenant(true) }
    const reset = vi.spyOn(useTagsStore(), 'reset')
    banner()
    expect(wrapper!.find('.tenant-banner').text()).toContain(
      i18n.global.t('layout.tenant.banner', { name: 'Acme Co' }),
    )
    await wrapper!.find('.tenant-banner button').trigger('click')
    await flushPromises()
    expect(calls.map((c) => `${c.method?.toUpperCase()} ${c.url}`)).toEqual([
      'POST /iam/tenants/leave',
    ])
    expect(reset).toHaveBeenCalledOnce()
    expect(replace).toHaveBeenCalledWith('/')
    expect(reset.mock.invocationCallOrder[0]).toBeLessThan(replace.mock.invocationCallOrder[0]!)
  })

  it('a refused leave keeps the page: no reload, the tags kept, the button usable again', async () => {
    mockApi({ 'POST /iam/tenants/leave': fail(403, 'A0403') })
    useAuthStore().me = { ...me(['*']), tenant: tenant(true) }
    const reset = vi.spyOn(useTagsStore(), 'reset')
    banner()
    await wrapper!.find('.tenant-banner button').trigger('click')
    await flushPromises()
    expect(replace).not.toHaveBeenCalled()
    expect(reset).not.toHaveBeenCalled()
    expect(wrapper!.find('.tenant-banner button').classes()).not.toContain('is-loading')
  })
})

describe('lock screen', () => {
  async function lock() {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/lock', component: LockView }],
    })
    await router.push('/lock')
    wrapper = mount(LockView, { global: { plugins: [ElementPlus, i18n, router] } })
    await flushPromises()
    return wrapper.find('.auth-page__subtitle').text()
  }

  it('adds the tenant worked in to its hint while acting, and nothing otherwise', async () => {
    const hint = i18n.global.t('layout.tenant.lockHint', { name: 'Acme Co' })
    const auth = useAuthStore()
    auth.me = { ...me(['*']), tenant: tenant(false) }
    expect(await lock()).not.toContain(hint)
    wrapper!.unmount()
    auth.me = { ...me(['*']), tenant: tenant(true) }
    const text = await lock()
    expect(text).toContain(i18n.global.t('layout.lock.hint', { name: 'Admin' }))
    expect(text).toContain(hint)
  })
})

describe('X-Tenant-Expect', () => {
  it('carries /me.tenant.id once /me named one (none while multi-tenancy is off or signed out)', async () => {
    const calls = mockApi({ 'GET /x': ok(1) })
    const auth = useAuthStore()
    const sent = async () => {
      await api.get('/x')
      return calls.at(-1)!.headers['X-Tenant-Expect']
    }
    expect(await sent()).toBeUndefined()
    auth.me = me(['*'])
    expect(await sent()).toBeUndefined()
    auth.clear()
    auth.me = { ...me(['*']), tenant: tenant(true) }
    expect(await sent()).toBe('7')
    auth.clear()
    expect(await sent()).toBeUndefined()
  })

  it('a 409 A1040 (the session works in another tenant by now) reloads the whole page', async () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined)
    mockApi({ 'PUT /y': fail(409, 'A1040'), 'PUT /z': fail(409, 'A0409') })
    useAuthStore().me = { ...me(['*']), tenant: tenant(false) }
    await expect(api.put('/y')).rejects.toMatchObject({ status: 409, code: 'A1040' })
    expect(reload).toHaveBeenCalledOnce()
    // another conflict is no tenant switch
    await expect(api.put('/z', null, { silent: true })).rejects.toMatchObject({ status: 409 })
    expect(reload).toHaveBeenCalledOnce()
  })
})
