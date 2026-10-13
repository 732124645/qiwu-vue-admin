// The tenant columns and filters of the four log pages: none while multi-tenancy is off (`/me` without
// `tenant`). On: the action and sign-in logs show whose tenant acted (the platform's staff as "platform");
// the sign-in log's "unresolved tenant" filter and the API logs' tenant filter and column are the platform
// root's alone.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import type { MePayload, MeTenant } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import ActionList from '@/views/platform/audit/action-log/index.vue'
import FaultList from '@/views/platform/audit/http-fault/index.vue'
import TraceList from '@/views/platform/audit/http-trace/index.vue'
import SigninList from '@/views/platform/audit/signin-log/index.vue'
import { me, mockApi, ok } from './mock-api'

const t = (key: string) => i18n.global.t(key)
const DEFAULT: MeTenant = {
  id: 1,
  code: 'default',
  name: 'seed.tenant.default',
  brandName: null,
  logoUrl: null,
  acting: false,
}
const ACME: MeTenant = { ...DEFAULT, id: 7, code: 'acme', name: 'Acme Co' }
const OPTIONS = [
  { id: 1, code: 'default', name: 'seed.tenant.default' },
  { id: 7, code: 'acme', name: 'Acme Co' },
]
const at = '2026-10-02T00:00:00.000Z'
const row = { username: 'u', userType: 'admin', ok: true, costMs: 1, createdAt: at, url: '/api/x' }

const PAGES = {
  action: {
    page: ActionList,
    url: '/audit/action-logs',
    label: 'field.audit.actionLog.actorTenantId',
    rows: [1, 7].map((actorTenantId, i) => ({
      ...row,
      id: i + 1,
      actorTenantId,
      domain: 'iam.user',
      verb: 'modify',
      httpMethod: 'PUT',
    })),
  },
  signin: {
    page: SigninList,
    url: '/audit/signin-logs',
    label: 'field.audit.signinLog.tenantId',
    rows: [1, 7, null].map((tenantId, i) => ({
      ...row,
      id: i + 1,
      tenantId,
      kind: 'password',
      clientId: 'console',
    })),
  },
  trace: {
    page: TraceList,
    url: '/audit/http-traces',
    label: 'field.audit.httpTrace.tenantId',
    rows: [7, null].map((tenantId, i) => ({
      ...row,
      id: i + 1,
      tenantId,
      method: 'GET',
      statusCode: 200,
      startedAt: at,
    })),
  },
  fault: {
    page: FaultList,
    url: '/audit/http-faults',
    label: 'field.audit.httpFault.tenantId',
    rows: [7, null].map((tenantId, i) => ({
      ...row,
      id: i + 1,
      tenantId,
      method: 'GET',
      errorName: 'Error',
      state: 'open',
    })),
  },
}
type Page = keyof typeof PAGES
const ALL = Object.keys(PAGES) as Page[]

let wrapper: VueWrapper | undefined
beforeEach(() => {
  setActivePinia(createPinia())
  accessToken.value = 'log-test'
  setLocale('en-US')
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

async function open(key: Page, session: MePayload) {
  const { page, url, rows } = PAGES[key]
  useAuthStore().me = session
  const calls = mockApi({
    [`GET ${url}`]: ok({ items: rows, total: rows.length }),
    'GET /iam/tenants/options': ok(OPTIONS),
  })
  wrapper = mount(page, { global: { plugins: [ElementPlus, i18n], directives: { perm: vPerm } } })
  await flushPromises()
  return calls
}
/** the cells of the column headed `label`; undefined: no such column */
function column(label: string) {
  const table = wrapper!.find('.el-table')
  const th = table.findAll('.el-table__header th').find((h) => h.text() === t(label))
  const name = th?.classes().find((c) => /^el-table_\d+_column_\d+$/.test(c))
  return (
    name && table.findAll('.el-table__body .el-table__row').map((r) => r.find(`td.${name}`).text())
  )
}
const filters = () => wrapper!.findAll('.qw-search-panel .el-form-item__label').map((l) => l.text())
const tenantFilters = (key: Page) => [t(PAGES[key].label), t('audit.signinLog.unresolvedTenant')]
const optionsAsked = (calls: { url?: string }[]) =>
  calls.some((c) => c.url === '/iam/tenants/options')

describe('multi-tenancy off', () => {
  it.each(ALL)('%s log: no tenant column, no tenant filter, no tenant list asked', async (key) => {
    const calls = await open(key, me(['*']))
    expect(column(PAGES[key].label)).toBeUndefined()
    expect(filters()).not.toContain(tenantFilters(key)[0])
    expect(filters()).not.toContain(tenantFilters(key)[1])
    expect(optionsAsked(calls)).toBe(false)
  })
})

describe('multi-tenancy on', () => {
  const admin = {
    ...me(['audit.actionLog.browse', 'audit.signinLog.browse', 'audit.signinLog.remove']),
    roles: ['tenant_admin'],
    tenant: ACME,
  }
  const root = { ...me(['*']), tenant: DEFAULT }

  it("a tenant's action and sign-in logs name the platform's rows and its own", async () => {
    await open('action', admin)
    expect(column(PAGES.action.label)).toEqual([t('audit.actionLog.platform'), 'Acme Co'])
    wrapper!.unmount()
    await open('signin', admin)
    expect(column(PAGES.signin.label)).toEqual([
      t('audit.signinLog.platform'),
      'Acme Co',
      t('audit.signinLog.unresolvedTenant'),
    ])
    // the unresolved filter is the platform root's
    expect(filters()).not.toContain(t('audit.signinLog.unresolvedTenant'))
  })

  it.each(['trace', 'fault'] as const)(
    '%s log: no tenant filter or column for anyone but the platform root',
    async (key) => {
      const calls = await open(key, {
        ...me(['*']),
        roles: ['auditor'],
        perms: ['x.y.z'],
        tenant: DEFAULT,
      })
      expect(column(PAGES[key].label)).toBeUndefined()
      expect(filters()).not.toContain(t(PAGES[key].label))
      expect(optionsAsked(calls)).toBe(false)
    },
  )

  it.each(['trace', 'fault'] as const)(
    "%s log: the platform root filters by tenant and sees each row's tenant",
    async (key) => {
      const calls = await open(key, root)
      expect(optionsAsked(calls)).toBe(true)
      expect(filters()).toContain(t(PAGES[key].label))
      // anonymous requests have no tenant
      expect(column(PAGES[key].label)).toEqual(['Acme Co', ''])
    },
  )

  it('sign-in log: the platform root lists the attempts of no tenant on request only', async () => {
    const calls = await open('signin', root)
    const lists = () => calls.filter((c) => c.url === PAGES.signin.url).map((c) => c.params)
    expect(lists()[0]).not.toHaveProperty('unresolved')
    expect(filters()).toContain(t('audit.signinLog.unresolvedTenant'))
    await wrapper!.find('.qw-search-panel .el-switch').trigger('click')
    await wrapper!.find('.qw-search-panel form').trigger('submit')
    await flushPromises()
    expect(lists().at(-1)).toMatchObject({ unresolved: true })
  })

  it('sign-in log: the unresolved rows are listed only, no detail link and no delete', async () => {
    await open('signin', root)
    const table = () => wrapper!.find('.el-table')
    const links = () => table().findAll('.el-table__body .qw-cell-link')
    const deletes = () =>
      table()
        .findAll('.el-table__body button')
        .filter((b) => b.text() === t('crud.action.delete'))
    const batchDeletes = () =>
      wrapper!.findAll('button').filter((b) => b.text() === t('crud.action.batchDelete'))
    const selectFirst = async () => {
      await table().find('.el-table__body .el-checkbox input').setValue(true)
      await flushPromises()
    }
    expect(links()).toHaveLength(3)
    expect(deletes()).toHaveLength(3)
    await selectFirst()
    expect(batchDeletes()).toHaveLength(1)

    await wrapper!.find('.qw-search-panel .el-switch').trigger('click')
    await wrapper!.find('.qw-search-panel form').trigger('submit')
    await flushPromises()
    // GET /:id and delete answer 404 for these rows: the username is plain text
    expect(links()).toHaveLength(0)
    expect(column('field.audit.signinLog.username')).toEqual(['u', 'u', 'u'])
    expect(deletes()).toHaveLength(0)
    await selectFirst()
    expect(batchDeletes()).toHaveLength(0)
  })
})
