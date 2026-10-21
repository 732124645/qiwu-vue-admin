// Tenant management page against a fake backend: an opened tenant's initial password is shown once (a reset
// one too), an edit sends neither the code nor the fields left as they were (the default tenant's form has no
// package or end), and entering a tenant drops the saved tags before the whole page reloads.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import type { MenuNode, TenantVo } from '@qiwu/shared'
import { dialogs } from '@/core/dialog'
import DialogHost from '@/core/dialog/DialogHost.vue'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { appSettings } from '@/core/stores/app'
import { useAuthStore } from '@/core/stores/auth'
import { useMenuStore } from '@/core/stores/menu'
import { useTagsStore } from '@/core/stores/tags'
import TenantPage from '@/views/platform/iam/tenant/index.vue'
import { me, mockApi, ok, type Route } from './mock-api'

const tenant = (p: Partial<TenantVo> & Pick<TenantVo, 'id' | 'code' | 'name'>): TenantVo => ({
  packageId: 3,
  packageName: 'Standard',
  enabled: true,
  expiresAt: null,
  userQuota: 10,
  userCount: 2,
  domains: [],
  brandName: null,
  logoObjectId: null,
  logoUrl: null,
  ownerUserId: 7,
  note: null,
  createdBy: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedBy: null,
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...p,
})
const DEFAULT = tenant({
  id: 1,
  code: 'default',
  name: 'seed.tenant.default',
  packageId: null,
  packageName: null,
  userQuota: null,
  ownerUserId: null,
})
// ended already: an edit that resent its end would disable it again
const ACME = tenant({
  id: 2,
  code: 'acme',
  name: 'Acme',
  domains: ['acme.example.com', 'acme.example.org'],
  expiresAt: '2020-01-01T00:00:00.000Z',
})

const t = (key: string, params: Record<string, unknown> = {}) => i18n.global.t(key, params)
const label = (prop: string) => t(`field.iam.tenant.${prop}`)
const body = () => new DOMWrapper(document.body)
const dialog = () => body().findAll('.el-dialog').at(-1)!
const rowOf = (text: string) =>
  page.findAll('.el-table__body .el-table__row').find((r) => r.text().includes(text))!
const button = (scope: DOMWrapper<Element>, text: string) =>
  scope.findAll('button').find((b) => b.text() === text)!
const field = (prop: string) =>
  dialog()
    .findAll('.el-form-item')
    .find((i) => i.find('.el-form-item__label').text() === label(prop))!
const sent = (calls: { method?: string; url?: string; data?: unknown }[], method: string) =>
  JSON.parse(calls.find((c) => c.method === method)!.data as string) as Record<string, unknown>

let page: VueWrapper
let host: VueWrapper
async function mountPage(routes: Record<string, Route>) {
  const calls = mockApi({
    'GET /iam/tenants': ok({ items: [DEFAULT, ACME], total: 2 }),
    'GET /iam/profile/prefs/table.iam.tenant': ok({ value: null }),
    'GET /settings/dicts/core.enabled/entries': ok({ version: 1, entries: [] }),
    'GET /iam/tenant-packages/options': ok([{ id: 3, name: 'Standard' }]),
    ...routes,
  })
  useAuthStore().me = me(['*'])
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  await router.push('/')
  const global = {
    plugins: [ElementPlus, i18n, router],
    directives: { perm: vPerm },
    stubs: { transition: false },
  }
  host = mount(DialogHost, { global, attachTo: document.body })
  page = mount(TenantPage, { global, attachTo: document.body })
  await flushPromises()
  return calls
}

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  // every row button inline: these cases look for them in the row, not in the "More" menu
  appSettings.value.tableActionsVisible = 9
  accessToken.value = 'at'
})
afterEach(() => {
  page?.unmount()
  host?.unmount()
  dialogs.splice(0)
  vi.restoreAllMocks()
  localStorage.clear()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('tenant page', () => {
  it('the AppID lookup shows only while the Official Account menus exist, and searches by it', async () => {
    const calls = await mountPage({})
    const appIdInput = () => page.find('.qw-search-panel input[name="appId"]')
    expect(appIdInput().exists()).toBe(false)
    useMenuStore().tree = [{ id: 9, routeName: 'wxoa', children: [] } as unknown as MenuNode]
    await nextTick()
    await appIdInput().setValue('wx0123456789abcdef')
    await page.find('.qw-search-panel form').trigger('submit')
    await flushPromises()
    expect(calls.filter((c) => c.url === '/iam/tenants').at(-1)!.params).toMatchObject({
      appId: 'wx0123456789abcdef',
    })
  })

  it('lists tenants; the default one cannot be disabled, entered or have a password reset', async () => {
    await mountPage({})
    const acme = rowOf('acme.example.org')
    expect(acme.text()).toContain('Standard')
    expect(acme.text()).toContain(t('iam.tenant.usage', { used: 2, quota: 10 }))
    const main = rowOf(t('iam.tenant.defaultTag'))
    expect(main.text()).toContain(t('iam.tenant.permanent'))
    expect(main.text()).toContain(t('iam.tenant.noDomains'))
    expect(main.find('.el-switch').classes()).toContain('is-disabled')
    expect(button(main, t('iam.tenant.enter.action')).attributes('disabled')).toBeDefined()
    expect(button(main, t('iam.tenant.resetPassword.action')).attributes('disabled')).toBeDefined()
    expect(acme.find('.el-switch').classes()).not.toContain('is-disabled')
    expect(button(acme, t('iam.tenant.enter.action')).attributes('disabled')).toBeUndefined()
    // no delete: a tenant is never deleted
    expect(page.findAll('button').some((b) => b.text() === t('crud.action.delete'))).toBe(false)
  })

  it('shows a sample package’s name (an i18n key) translated: in the list and the package select', async () => {
    const KEY = 'seed.tenantPackage.noWorkflow'
    await mountPage({
      'GET /iam/tenants': ok({ items: [DEFAULT, { ...ACME, packageName: KEY }], total: 2 }),
      'GET /iam/tenant-packages/options': ok([{ id: 3, name: KEY }]),
    })
    const shown = t(KEY)
    expect(shown).not.toBe(KEY)
    expect(rowOf('acme.example.org').text()).toContain(shown)
    expect(page.text()).not.toContain(KEY)
    await button(new DOMWrapper(page.element), t('crud.action.create')).trigger('click')
    await flushPromises()
    await field('packageId').find('.el-select__wrapper').trigger('click')
    await flushPromises()
    expect(
      body()
        .findAll('.el-select-dropdown__item')
        .map((o) => o.text()),
    ).toEqual([shown])
  })

  it('opening a tenant shows its initial password once, in a dialog ESC does not close', async () => {
    const PASSWORD = 'Init-Pass-4711'
    const calls = await mountPage({
      'POST /iam/tenants': ok({
        ...tenant({ id: 9, code: 'beta', name: 'Beta' }),
        initialPassword: PASSWORD,
      }),
    })
    await button(new DOMWrapper(page.element), t('crud.action.create')).trigger('click')
    await flushPromises()
    await field('code').find('input').setValue('beta')
    await field('name').find('input').setValue('Beta')
    await field('packageId').find('.el-select__wrapper').trigger('click')
    await flushPromises()
    await body()
      .findAll('.el-select-dropdown__item')
      .find((o) => o.text() === 'Standard')!
      .trigger('click')
    await field('username').find('input').setValue('boss')
    await field('displayName').find('input').setValue('Boss')
    await button(dialog(), t('crud.action.save')).trigger('click')
    await flushPromises()

    const posted = sent(calls, 'post')
    expect(posted).toMatchObject({
      code: 'beta',
      name: 'Beta',
      packageId: 3,
      admin: { username: 'boss', displayName: 'Boss' },
    })
    const shown = dialogs.at(-1)!
    expect(shown.closeOnPressEscape).toBe(false)
    const values = dialog()
      .findAll('input')
      .map((i) => (i.element as HTMLInputElement).value)
    expect(values).toEqual(['boss', PASSWORD])
    // the list never holds it
    expect(page.html()).not.toContain(PASSWORD)

    await button(dialog(), t('iam.tenant.saved')).trigger('click')
    await flushPromises()
    expect(shown.visible).toBe(false)
    expect(dialogs.filter((d) => d.visible)).toEqual([])
  })

  it('an edit sends only the fields changed: never the code, nor an end already past', async () => {
    const calls = await mountPage({
      'GET /iam/tenants/2': ok(ACME),
      'PUT /iam/tenants/2': ok(null),
    })
    await button(rowOf('acme.example.org'), t('crud.action.edit')).trigger('click')
    await flushPromises()
    const code = field('code').find('input')
    expect((code.element as HTMLInputElement).value).toBe('acme')
    expect(code.attributes('disabled')).toBeDefined()
    // the administrator is fixed once opened
    expect(dialog().text()).not.toContain(label('username'))
    await field('name').find('input').setValue('Acme Ltd')
    await button(dialog(), t('crud.action.save')).trigger('click')
    await flushPromises()

    const put = sent(calls, 'put')
    expect(put).toEqual({ name: 'Acme Ltd' })
    expect(put).not.toHaveProperty('code')
  })

  it('the default tenant is edited without package or end; a new name alone is sent', async () => {
    const calls = await mountPage({
      'GET /iam/tenants/1': ok(DEFAULT),
      'PUT /iam/tenants/1': ok(null),
    })
    await button(rowOf(t('iam.tenant.defaultTag')), t('crud.action.edit')).trigger('click')
    await flushPromises()
    const labels = dialog()
      .findAll('.el-form-item__label')
      .map((l) => l.text())
    expect(labels).toContain(label('name'))
    expect(labels).not.toContain(label('packageId'))
    expect(labels).not.toContain(label('expiresAt'))
    await field('name').find('input').setValue('Platform')
    await button(dialog(), t('crud.action.save')).trigger('click')
    await flushPromises()
    expect(sent(calls, 'put')).toEqual({ name: 'Platform' })
  })

  it('resetting the initial password shows the new one once, in a dialog ESC does not close', async () => {
    const PASSWORD = 'Reset-Pass-0815'
    const calls = await mountPage({
      'POST /iam/tenants/2/initial-password': ok({ initialPassword: PASSWORD }),
    })
    await button(rowOf('acme.example.org'), t('iam.tenant.resetPassword.action')).trigger('click')
    await flushPromises()
    expect(calls.some((c) => c.method === 'post')).toBe(false)
    await body().find('.el-message-box__btns .el-button--primary').trigger('click')
    await flushPromises()
    expect(calls.filter((c) => c.method === 'post').map((c) => c.url)).toEqual([
      '/iam/tenants/2/initial-password',
    ])
    expect(dialogs.at(-1)!.closeOnPressEscape).toBe(false)
    const values = dialog()
      .findAll('input')
      .map((i) => (i.element as HTMLInputElement).value)
    expect(values).toEqual([PASSWORD])
  })

  it('entering asks a reason, then drops the saved tags before reloading the whole page', async () => {
    let tagsAtReload: string | null = 'not reloaded'
    const replace = vi
      .spyOn(window.location, 'replace')
      .mockImplementation(() => void (tagsAtReload = localStorage.getItem('qw.tags.list')))
    const calls = await mountPage({ 'POST /iam/tenants/2/enter': ok(null) })
    useTagsStore().open({ path: '/iam/tenants', fullPath: '/iam/tenants', meta: {} } as never)
    await nextTick()
    expect(JSON.parse(localStorage.getItem('qw.tags.list') ?? '[]')).toHaveLength(1)

    await button(rowOf('acme.example.org'), t('iam.tenant.enter.action')).trigger('click')
    await flushPromises()
    // no reason, no request
    await button(dialog(), t('iam.tenant.enter.submit')).trigger('click')
    await flushPromises()
    expect(calls.some((c) => c.url === '/iam/tenants/2/enter')).toBe(false)

    await field('reason').find('textarea').setValue('ticket 42')
    await button(dialog(), t('iam.tenant.enter.submit')).trigger('click')
    await flushPromises()
    expect(sent(calls, 'post')).toEqual({ reason: 'ticket 42' })
    expect(replace).toHaveBeenCalledWith('/')
    expect(tagsAtReload).toBe('[]')
  })
})
