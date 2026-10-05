import { afterEach, beforeEach, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import type { MailTemplateVo, SmsTemplateVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import MailList from '@/views/platform/messaging/mail-template/index.vue'
import MailDetail from '@/views/platform/messaging/mail-template/detail.vue'
import MailForm from '@/views/platform/messaging/mail-template/form.vue'
import SmsList from '@/views/platform/messaging/sms-template/index.vue'
import SmsForm from '@/views/platform/messaging/sms-template/form.vue'
import { me, mockApi, ok } from './mock-api'

const localeDict = ok({
  version: 1,
  entries: [
    {
      value: 'zh-CN',
      label: 'Simplified Chinese',
      labelI18n: null,
      tagType: null,
      cssClass: null,
      isDefault: true,
      sortNo: 0,
    },
    {
      value: 'en-US',
      label: 'English',
      labelI18n: null,
      tagType: null,
      cssClass: null,
      isDefault: false,
      sortNo: 1,
    },
  ],
})
const mail: MailTemplateVo = {
  id: 5,
  code: 'mail-5',
  locale: 'en-US',
  name: 'Mail',
  accountId: null,
  accountName: null,
  senderLabel: null,
  subject: 'Subject',
  body: 'Body',
  paramNames: null,
  enabled: true,
  createdBy: 1,
  createdAt: '2026-09-28T01:00:00.000Z',
  updatedBy: 1,
  updatedAt: '2026-09-28T01:00:00.000Z',
}
const sms: SmsTemplateVo = {
  id: 7,
  code: 'sms-7',
  locale: 'en-US',
  channelId: null,
  channelName: null,
  name: 'SMS',
  purpose: 'notice',
  body: 'Body',
  paramNames: null,
  providerTemplateId: null,
  enabled: true,
  createdBy: 1,
  createdAt: '2026-09-28T01:00:00.000Z',
  updatedBy: 1,
  updatedAt: '2026-09-28T01:00:00.000Z',
}

let wrapper: VueWrapper | undefined
beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  useAuthStore().me = me(['*'])
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

async function show(component: typeof MailList | typeof SmsList) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  await router.push('/')
  wrapper = mount(component, {
    global: { plugins: [ElementPlus, i18n, router], directives: { perm: vPerm } },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

it('mail list labels the locale and filters by its exact code', async () => {
  const calls = mockApi({
    'GET /settings/dicts/core.locale/entries': localeDict,
    'GET /messaging/mail-templates': ok({ items: [mail], total: 1 }),
  })
  const page = await show(MailList)
  expect(page.find('.el-table__body .el-table__row').findAll('td')[2]!.text()).toBe('English')

  await page.find('.qw-search-panel .el-form-item:nth-child(2) .el-select').trigger('click')
  await new DOMWrapper(document.body)
    .findAll('.el-select-dropdown__item')
    .find((item) => item.text() === 'English')!
    .trigger('click')
  await page.find('.qw-search-panel form').trigger('submit')
  await flushPromises()
  expect(
    calls.filter((call) => call.url === '/messaging/mail-templates').at(-1)?.params,
  ).toMatchObject({ locale: 'en-US' })
})

it('mail detail labels the locale', async () => {
  mockApi({
    'GET /settings/dicts/core.locale/entries': localeDict,
    'GET /messaging/mail-templates/5': ok(mail),
  })
  wrapper = mount(MailDetail, { props: { id: 5 }, global: { plugins: [ElementPlus, i18n] } })
  await flushPromises()
  expect(wrapper.find('.el-descriptions').text()).toContain('English')
  expect(wrapper.find('.el-descriptions').text()).not.toContain('en-US')
})

it('SMS list labels the locale', async () => {
  mockApi({
    'GET /settings/dicts/core.locale/entries': localeDict,
    'GET /messaging/sms-templates': ok({ items: [sms], total: 1 }),
  })
  const page = await show(SmsList)
  expect(page.find('.el-table__body .el-table__row').findAll('td')[2]!.text()).toBe('English')
})

it('mail and SMS forms label the selected locale', async () => {
  mockApi({
    'GET /settings/dicts/core.locale/entries': localeDict,
    'GET /messaging/mail-templates/5': ok(mail),
    'GET /messaging/sms-templates/7': ok(sms),
    'GET /messaging/mail-accounts/options': ok([]),
    'GET /messaging/sms-channels/options': ok([]),
  })
  wrapper = mount(MailForm, {
    props: { id: 5 },
    global: { plugins: [ElementPlus, i18n], stubs: { RichEditor: true } },
    attachTo: document.body,
  })
  await flushPromises()
  expect(wrapper.findAll('.el-form-item')[1]!.find('.el-select').text()).toContain('English')
  wrapper.unmount()
  wrapper = mount(SmsForm, {
    props: { id: 7 },
    global: { plugins: [ElementPlus, i18n] },
    attachTo: document.body,
  })
  await flushPromises()
  expect(wrapper.findAll('.el-form-item')[1]!.find('.el-select').text()).toContain('English')
})
