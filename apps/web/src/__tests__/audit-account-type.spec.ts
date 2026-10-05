import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import SigninList from '@/views/platform/audit/signin-log/index.vue'
import SigninDetail from '@/views/platform/audit/signin-log/detail.vue'
import ActionList from '@/views/platform/audit/action-log/index.vue'
import ActionDetail from '@/views/platform/audit/action-log/detail.vue'
import { me, mockApi, ok } from './mock-api'

const entries = [
  {
    value: 'admin',
    label: '审计管理员',
    labelI18n: { 'zh-CN': '审计管理员', 'en-US': 'Audit admin' },
  },
  {
    value: 'member',
    label: '审计会员',
    labelI18n: { 'zh-CN': '审计会员', 'en-US': 'Audit member' },
  },
]

let wrapper: VueWrapper | undefined
beforeEach(() => {
  setActivePinia(createPinia())
  useAuthStore().me = me(['*'])
  accessToken.value = 'audit-test'
  setLocale('en-US')
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

it.each([
  ['signin', SigninList, SigninDetail],
  ['action', ActionList, ActionDetail],
] as const)(
  '%s audit list and detail display translated types and future codes',
  async (kind, List, Detail) => {
    const rows = ['admin', 'member', 'future-kind'].map((userType, i) => ({
      id: i + 1,
      userId: 7,
      username: 'audited-user',
      userType,
      createdAt: '2026-10-02T00:00:00.000Z',
      kind: 'password',
      clientId: 'console',
      domain: 'iam.profile',
      verb: 'modify',
      httpMethod: 'PUT',
      url: '/api/iam/profile',
      ok: true,
      costMs: 1,
    }))
    const path = `/audit/${kind}-logs`
    const label = `field.audit.${kind}Log.userType`
    mockApi({
      [`GET ${path}`]: ok({ items: rows, total: rows.length }),
      [`GET /iam/profile/prefs/table.audit.${kind}Log`]: ok({ value: null }),
      'GET /settings/dicts/audit.signin_kind/entries': ok({ entries: [] }),
      'GET /settings/dicts/audit.verb/entries': ok({ entries: [] }),
      'GET /settings/dicts/core.yes_no/entries': ok({ entries: [] }),
      'GET /settings/dicts/audit.user_type/entries': ok({ entries }),
      ...Object.fromEntries(rows.map((r) => [`GET ${path}/${r.id}`, ok(r)])),
    })
    const global = { plugins: [ElementPlus, i18n], directives: { perm: vPerm } }
    wrapper = mount(List, { global })
    await flushPromises()
    for (const lang of ['en-US', 'zh-CN'] as const) {
      setLocale(lang)
      await flushPromises()
      const table = wrapper.find('.el-table')
      const header = table
        .findAll('.el-table__header th')
        .find((th) => th.text() === i18n.global.t(label))
      expect(header).toBeDefined()
      const column = header!.classes().find((name) => /^el-table_\d+_column_\d+$/.test(name))!
      expect(column).toBeDefined()
      expect(
        table.findAll('.el-table__body .el-table__row').map((r) => r.find(`td.${column}`).text()),
      ).toEqual([entries[0]!.labelI18n[lang], entries[1]!.labelI18n[lang], 'future-kind'])
    }
    wrapper.unmount()
    for (const row of rows) {
      wrapper = mount(Detail, { props: { id: row.id }, global })
      await flushPromises()
      for (const lang of ['en-US', 'zh-CN'] as const) {
        setLocale(lang)
        await flushPromises()
        const labels = wrapper.findAll('.el-descriptions__label')
        const index = labels.findIndex((node) => node.text() === i18n.global.t(label))
        expect(index).toBeGreaterThanOrEqual(0)
        expect(wrapper.findAll('.el-descriptions__content')[index]!.text()).toBe(
          entries.find((e) => e.value === row.userType)?.labelI18n[lang] ?? row.userType,
        )
      }
      wrapper.unmount()
    }
    wrapper = undefined
  },
)
