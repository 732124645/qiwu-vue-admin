// User add/edit form (iam/user, dialog content): held roles the options leave out (disabled) are
// shown by name, never as a raw id; against a fake backend.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import UserForm from '@/views/platform/iam/user/form.vue'
import { mockApi, ok } from './mock-api'

let form: VueWrapper
beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
})
afterEach(() => {
  form.unmount()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('user form', () => {
  it('a held disabled role (not in the options) is shown by its name', async () => {
    mockApi({
      'GET /iam/users/5': ok({
        id: 5,
        username: 'ann',
        displayName: 'Ann',
        deptId: null,
        gender: 'unknown',
        enabled: true,
        roleIds: [1, 9],
        roles: [
          { id: 1, name: 'Auditor' },
          { id: 9, name: 'Retired role' },
        ],
        positionIds: [],
      }),
      'GET /iam/roles/options': ok([{ id: 1, code: 'auditor', name: 'Auditor' }]),
      'GET /iam/positions/options': ok([]),
      'GET /settings/dicts/iam.gender/entries': ok({ version: 1, entries: [] }),
    })
    form = mount(UserForm, {
      props: { id: 5 },
      global: { plugins: [ElementPlus, i18n], stubs: { DeptTreeSelect: true } },
      attachTo: document.body,
    })
    await flushPromises()
    const tags = form.findAll('.el-select__tags-text').map((t) => t.text())
    expect(tags).toEqual(['Auditor', 'Retired role'])
  })
})
