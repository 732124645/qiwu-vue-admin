import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import type { AppVersionVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import AppVersionPage from '@/views/platform/settings/app-version/index.vue'
import { me, mockApi, ok } from './mock-api'

const ROWS: AppVersionVo[] = ['1.0.1', '1.0.2'].map((version, index) => ({
  id: index + 1,
  platform: 'android',
  packageKind: 'wgt',
  version,
  nativeMin: '1.0.0',
  url: `https://example.com/${version}.wgt`,
  isForced: false,
  enabled: true,
  notes: null,
  createdBy: null,
  updatedBy: null,
  createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
}))

let page: VueWrapper
beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
})
afterEach(() => {
  page?.unmount()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

it('labels enabled switches with the platform dict label and each version', async () => {
  mockApi({
    'GET /settings/app-versions': ok({ items: ROWS, total: ROWS.length }),
    'GET /iam/profile/prefs/table.settings.appVersion': ok({ value: null }),
    'GET /settings/dicts/settings.app_platform/entries': ok({
      version: 1,
      entries: [{ value: 'android', label: 'Android', labelI18n: null }],
    }),
    'GET /settings/dicts/settings.app_package_kind/entries': ok({ version: 1, entries: [] }),
    'GET /settings/dicts/core.yes_no/entries': ok({ version: 1, entries: [] }),
    'GET /settings/dicts/core.enabled/entries': ok({ version: 1, entries: [] }),
  })
  useAuthStore().me = me(['*'])
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  await router.push('/')
  page = mount(AppVersionPage, {
    global: { plugins: [ElementPlus, i18n, router], directives: { perm: vPerm } },
    attachTo: document.body,
  })
  await flushPromises()

  const labels = page
    .findAll('.el-table__body [role="switch"]')
    .map((s) => s.attributes('aria-label'))
  expect(labels).toEqual(
    ROWS.map(
      (row) => `${i18n.global.t('field.settings.appVersion.enabled')} Android ${row.version}`,
    ),
  )
  expect(new Set(labels).size).toBe(2)
})
