import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
import { i18n, setLocale } from '@/core/i18n'
import ProfileView from '@/views/profile/index.vue'
import { mockApi, ok } from './mock-api'

const profile = {
  id: 42,
  username: 'person',
  displayName: 'Person',
  gender: 'unknown',
  mobile: '13800138000',
  email: null,
  avatarUrl: null,
  locale: null,
  deptName: null,
  roleNames: [],
  positionNames: [],
}
const body = (call: { data?: unknown }) => JSON.parse(String(call.data))
const page = async () => {
  const wrapper = mount(ProfileView, { global: { plugins: [createPinia(), i18n, ElementPlus] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

it('asks for credentials only after a mobile edit, sends to the new number and omits them for other edits', async () => {
  const calls = mockApi({
    'GET /iam/profile': ok(profile),
    'POST /iam/profile/mobile/code': ok({ cooldownSec: 60 }),
    'PUT /iam/profile': (call) => ok({ ...profile, ...body(call) }),
  })
  const wrapper = await page()
  expect(wrapper.find('input[name="currentPassword"]').exists()).toBe(false)
  expect(wrapper.find('input[name="mobileCode"]').exists()).toBe(false)

  const mobile = wrapper.findAll('.el-form-item').find((i) => i.text().includes('Mobile'))!
  await mobile.find('input').setValue('13800138001')
  expect(wrapper.find('input[name="currentPassword"]').exists()).toBe(true)
  expect(wrapper.find('input[name="mobileCode"]').exists()).toBe(true)
  await wrapper.find('input[name="currentPassword"]').setValue('Current#Pass1')
  await wrapper.find('input[name="mobileCode"]').setValue('123456')
  await wrapper
    .findAll('button')
    .find((b) => b.text().includes('Get code'))!
    .trigger('click')
  await flushPromises()
  expect(body(calls.find((c) => c.url === '/iam/profile/mobile/code')!)).toEqual({
    mobile: '13800138001',
  })
  await wrapper.find('form').trigger('submit')
  await flushPromises()
  expect(body(calls.find((c) => c.url === '/iam/profile' && c.method === 'put')!)).toMatchObject({
    mobile: '13800138001',
    currentPassword: 'Current#Pass1',
    mobileCode: '123456',
  })
  expect(wrapper.find('input[name="currentPassword"]').exists()).toBe(false)

  const name = wrapper.findAll('.el-form-item').find((i) => i.text().includes('Display name'))!
  await name.find('input').setValue('Other')
  await wrapper.find('form').trigger('submit')
  await flushPromises()
  const updates = calls.filter((c) => c.url === '/iam/profile' && c.method === 'put')
  expect(body(updates[1]!)).not.toHaveProperty('currentPassword')
  expect(body(updates[1]!)).not.toHaveProperty('mobileCode')
  wrapper.unmount()
})
