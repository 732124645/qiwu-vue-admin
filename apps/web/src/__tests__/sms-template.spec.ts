// An auth.* (code) template never falls back to the default channel: without a channel no code is sent,
// so the form, the list and the detail say "not set" there; ordinary templates keep "Default channel".
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import type { SmsTemplateVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import SmsList from '@/views/platform/messaging/sms-template/index.vue'
import SmsDetail from '@/views/platform/messaging/sms-template/detail.vue'
import SmsForm from '@/views/platform/messaging/sms-template/form.vue'
import { me, mockApi, ok } from './mock-api'

const sms = (id: number, code: string, channelId: number | null = null): SmsTemplateVo => ({
  id,
  code,
  locale: 'en-US',
  channelId,
  channelName: channelId === null ? null : 'Aliyun',
  name: `SMS ${id}`,
  purpose: 'notice',
  body: 'Body',
  paramNames: null,
  providerTemplateId: null,
  enabled: true,
  createdBy: 1,
  createdAt: '2026-09-28T01:00:00.000Z',
  updatedBy: 1,
  updatedAt: '2026-09-28T01:00:00.000Z',
})
const UNSET = 'Not set — no codes are sent'
const HINT = 'Code templates must use an enabled channel of their own'

let wrapper: VueWrapper | undefined
beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  useAuthStore().me = me(['*'])
  mockApi({
    'GET /messaging/sms-templates': ok({
      items: [sms(1, 'auth.sms_code'), sms(2, 'order.shipped')],
      total: 2,
    }),
    'GET /messaging/sms-templates/1': ok(sms(1, 'auth.sms_code')),
    'GET /messaging/sms-templates/2': ok(sms(2, 'order.shipped')),
    'GET /messaging/sms-templates/3': ok(sms(3, 'AUTH.reset_code', 4)),
    'GET /messaging/sms-channels/options': ok([{ id: 4, name: 'Aliyun' }]),
  })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

const mountForm = async (id: number) => {
  wrapper?.unmount()
  wrapper = mount(SmsForm, { props: { id }, global: { plugins: [ElementPlus, i18n] } })
  await flushPromises()
  const item = wrapper
    .findAll('.el-form-item')
    .find((i) => i.find('.el-form-item__label').text() === 'SMS channel')!
  return { shown: item.find('.el-select__placeholder').text(), hint: item.find('.field-hint') }
}

it('form: an auth.* template without a channel says not set and warns; an ordinary one keeps the default', async () => {
  const auth = await mountForm(1)
  expect(auth.shown).toBe(UNSET)
  expect(auth.hint.text()).toContain(HINT)
  expect(auth.hint.classes()).toContain('is-unset')

  const withChannel = await mountForm(3)
  expect(withChannel.shown).toBe('Aliyun')
  expect(withChannel.hint.text()).toContain(HINT)
  expect(withChannel.hint.classes()).not.toContain('is-unset')

  const plain = await mountForm(2)
  expect(plain.shown).toBe('Default channel')
  expect(plain.hint.exists()).toBe(false)
})

it('list and detail: not set (warning) for the auth.* template, Default channel for the ordinary one', async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  await router.push('/')
  wrapper = mount(SmsList, {
    global: { plugins: [ElementPlus, i18n, router], directives: { perm: vPerm } },
    attachTo: document.body,
  })
  await flushPromises()
  const [auth, plain] = wrapper.findAll('.el-table__body .el-table__row')
  expect(auth!.find('.el-text--warning').text()).toBe(UNSET)
  expect(plain!.text()).toContain('Default channel')
  expect(plain!.find('.el-text--warning').exists()).toBe(false)

  wrapper.unmount()
  wrapper = mount(SmsDetail, { props: { id: 1 }, global: { plugins: [ElementPlus, i18n] } })
  await flushPromises()
  expect(wrapper.find('.el-descriptions .el-text--warning').text()).toBe(UNSET)
  wrapper.unmount()
  wrapper = mount(SmsDetail, { props: { id: 2 }, global: { plugins: [ElementPlus, i18n] } })
  await flushPromises()
  expect(wrapper.find('.el-descriptions').text()).toContain('Default channel')
  expect(wrapper.find('.el-text--warning').exists()).toBe(false)
})
