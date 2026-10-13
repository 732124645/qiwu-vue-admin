// The role and user lists disable what the server refuses: the builtin root and tenant_admin roles are
// never switched off and keep fixed grants (no menu grant, no data scope); a user the server marks
// `protected` for the caller (the tenant's owner, a tenant_admin holder) is not edited, reset or re-roled.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElDropdownItem, ElSwitch } from 'element-plus'
import { TENANT_ADMIN_ROLE, type RoleVo, type UserVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import RolePage from '@/views/platform/iam/role/index.vue'
import RoleForm from '@/views/platform/iam/role/form.vue'
import UserPage from '@/views/platform/iam/user/index.vue'
import { me, mockApi, ok } from './mock-api'

const at = '2026-10-01T00:00:00.000Z'
const audit = { createdBy: null, createdAt: at, updatedBy: null, updatedAt: at }
const role = (id: number, code: string, isBuiltin: boolean): RoleVo => ({
  id,
  name: code,
  code,
  sortNo: id,
  dataScope: 'all',
  menuLink: true,
  deptLink: true,
  isBuiltin,
  enabled: true,
  note: null,
  ...audit,
})
const ROLES = [role(1, 'root', true), role(2, TENANT_ADMIN_ROLE, true), role(3, 'auditor', false)]
const user = (id: number, flags: Pick<UserVo, 'root' | 'protected'>): UserVo => ({
  id,
  username: `u${id}`,
  displayName: `U${id}`,
  deptId: null,
  deptName: null,
  mobile: null,
  email: null,
  masked: false,
  gender: 'unknown',
  avatarUrl: null,
  enabled: true,
  lastLoginAt: null,
  note: null,
  ...flags,
  ...audit,
})
// the owner, a plain user, a root user the caller (root) may edit
const USERS = [
  user(11, { root: false, protected: true }),
  user(12, { root: false, protected: false }),
  user(13, { root: true, protected: false }),
]

let wrapper: VueWrapper
beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
})
afterEach(() => {
  wrapper.unmount()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

async function open(page: typeof RolePage | typeof UserPage) {
  mockApi({
    'GET /iam/roles': ok({ items: ROLES, total: ROLES.length }),
    'GET /iam/users': ok({ items: USERS, total: USERS.length }),
    'GET /iam/depts/tree': ok([]),
    'GET /iam/profile/prefs/table.iam.role': ok({ value: null }),
    'GET /iam/profile/prefs/table.iam.user': ok({ value: null }),
  })
  useAuthStore().me = me(['*'])
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  await router.push('/')
  wrapper = mount(page, {
    global: { plugins: [ElementPlus, i18n, router], directives: { perm: vPerm } },
    attachTo: document.body,
  })
  await flushPromises()
}
const rows = () => wrapper.findAll('.el-table__body .el-table__row')
/** per row, whether its button `text` is disabled */
const buttons = (text: string) =>
  rows().map(
    (r) =>
      r
        .findAll('button')
        .find((b) => b.text() === text)!
        .attributes('disabled') !== undefined,
  )
/** per row, whether its "more" item `command` is disabled (el-table renders the slot once without a row) */
const items = (command: string) =>
  wrapper
    .findAllComponents(ElDropdownItem)
    .filter((i) => i.props('command') === command)
    .map((i) => i.props('disabled') as boolean | undefined)
    .filter((d) => d !== undefined)

describe('role list', () => {
  it('root and the builtin tenant_admin role: no switch off, no menu grant, no data scope', async () => {
    await open(RolePage)
    expect(rows().map((r) => r.findComponent(ElSwitch).props('disabled'))).toEqual([
      true,
      true,
      false,
    ])
    expect(items('grant')).toEqual([true, true, false])
    expect(items('data-scope')).toEqual([true, true, false])
    // a non-builtin role named like them is a plain role
    wrapper.unmount()
    ROLES[1] = role(2, TENANT_ADMIN_ROLE, false)
    try {
      await open(RolePage)
      expect(items('grant')).toEqual([true, false, false])
    } finally {
      ROLES[1] = role(2, TENANT_ADMIN_ROLE, true)
    }
  })

  it('the edit form keeps the builtin tenant_admin role enabled', async () => {
    mockApi({ 'GET /iam/roles/2': ok(ROLES[1]), 'GET /iam/roles/3': ok(ROLES[2]) })
    const enabledSwitch = async (id: number) => {
      wrapper = mount(RoleForm, { props: { id }, global: { plugins: [ElementPlus, i18n] } })
      await flushPromises()
      const off = wrapper.findComponent(ElSwitch).props('disabled')
      wrapper.unmount()
      return off
    }
    expect(await enabledSwitch(2)).toBe(true)
    expect(await enabledSwitch(3)).toBe(false)
    wrapper = mount({ render: () => null })
  })
})

describe('user list', () => {
  it('a protected user is not edited, reset, re-roled, switched off or deleted; a root user is not re-roled', async () => {
    await open(UserPage)
    expect(buttons('Edit')).toEqual([true, false, false])
    expect(buttons('Delete')).toEqual([true, false, true])
    expect(rows().map((r) => r.findComponent(ElSwitch).props('disabled'))).toEqual([
      true,
      false,
      true,
    ])
    expect(items('reset-password')).toEqual([true, false, false])
    expect(items('assign-roles')).toEqual([true, false, true])
  })
})
