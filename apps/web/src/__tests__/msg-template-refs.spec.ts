import { afterEach, beforeEach, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
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
import SmsDetail from '@/views/platform/messaging/sms-template/detail.vue'
import SmsForm from '@/views/platform/messaging/sms-template/form.vue'
import { me, mockApi, ok } from './mock-api'

const mail = (id: number, extra: Partial<MailTemplateVo> = {}): MailTemplateVo => ({
  id,
  code: `mail-${id}`,
  locale: 'en-US',
  name: `Mail ${id}`,
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
  ...extra,
})
const sms = (id: number, extra: Partial<SmsTemplateVo> = {}): SmsTemplateVo => ({
  id,
  code: `sms-${id}`,
  locale: 'en-US',
  channelId: null,
  channelName: null,
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
  ...extra,
})

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

it('mail list shows the disabled account name from the VO without loading options', async () => {
  const calls = mockApi({
    'GET /messaging/mail-templates': ok({
      items: [mail(5, { accountId: 9, accountName: 'Retired mail account' })],
      total: 1,
    }),
  })
  const page = await show(MailList)
  expect(page.find('.el-table__body .el-table__row').text()).toContain('Retired mail account')
  expect(calls.some((call) => call.url === '/messaging/mail-accounts/options')).toBe(false)
})

it('mail detail shows the account name and default text for null', async () => {
  mockApi({
    'GET /messaging/mail-templates/5': ok(
      mail(5, { accountId: 9, accountName: 'Retired mail account' }),
    ),
    'GET /messaging/mail-templates/6': ok(mail(6)),
  })
  wrapper = mount(MailDetail, { props: { id: 5 }, global: { plugins: [ElementPlus, i18n] } })
  await flushPromises()
  expect(wrapper.find('.el-descriptions').text()).toContain('Retired mail account')
  wrapper.unmount()
  wrapper = mount(MailDetail, { props: { id: 6 }, global: { plugins: [ElementPlus, i18n] } })
  await flushPromises()
  expect(wrapper.find('.el-descriptions').text()).toContain('Default account')
})

it('mail form shows a disabled selected account by name', async () => {
  mockApi({
    'GET /messaging/mail-templates/5': ok(
      mail(5, { accountId: 9, accountName: 'Retired mail account' }),
    ),
    'GET /messaging/mail-accounts/options': ok([{ id: 1, name: 'Active account' }]),
  })
  wrapper = mount(MailForm, {
    props: { id: 5 },
    global: { plugins: [ElementPlus, i18n], stubs: { RichEditor: true } },
    attachTo: document.body,
  })
  await flushPromises()
  const select = wrapper
    .findAll('.el-form-item')
    .find((item) => item.text().includes('Mail account'))!
  expect(select.find('.el-select__placeholder').text()).toBe('Retired mail account')
})

it('SMS list shows a disabled channel name from the VO', async () => {
  const calls = mockApi({
    'GET /messaging/sms-templates': ok({
      items: [sms(7, { channelId: 8, channelName: 'Retired SMS channel' })],
      total: 1,
    }),
  })
  const page = await show(SmsList)
  expect(page.find('.el-table__body .el-table__row').text()).toContain('Retired SMS channel')
  expect(calls.some((call) => call.url === '/messaging/sms-channels/options')).toBe(false)
})

// Soft delete: a deleted account / channel keeps its id on the template, the API sends no name
it('a deleted account or channel shows as #<id> (deleted) in the lists, the detail and the form', async () => {
  mockApi({
    'GET /messaging/mail-templates': ok({
      items: [mail(5, { accountId: 9, accountName: null })],
      total: 1,
    }),
    'GET /messaging/sms-templates': ok({
      items: [sms(7, { channelId: 8, channelName: null })],
      total: 1,
    }),
    'GET /messaging/mail-templates/5': ok(mail(5, { accountId: 9, accountName: null })),
    'GET /messaging/sms-templates/7': ok(sms(7, { channelId: 8, channelName: null })),
    'GET /messaging/mail-accounts/options': ok([{ id: 1, name: 'Active account' }]),
    'GET /messaging/sms-channels/options': ok([{ id: 1, name: 'Active channel' }]),
  })
  const rowText = async (list: typeof MailList | typeof SmsList) => {
    const text = (await show(list)).find('.el-table__body .el-table__row').text()
    wrapper!.unmount()
    return text
  }
  expect(await rowText(MailList)).toContain('#9 (deleted)')
  expect(await rowText(SmsList)).toContain('#8 (deleted)')

  // the detail's text, or the form's select under the label `field`
  const shown = async (component: unknown, id: number, field?: string) => {
    wrapper = mount(component as typeof MailDetail, {
      props: { id },
      global: { plugins: [ElementPlus, i18n], stubs: { RichEditor: true } },
      attachTo: document.body,
    })
    await flushPromises()
    const text = field
      ? wrapper
          .findAll('.el-form-item')
          .find((item) => item.find('.el-form-item__label').text() === i18n.global.t(field))!
          .find('.el-select__placeholder')
          .text()
      : wrapper.find('.el-descriptions').text()
    wrapper.unmount()
    return text
  }
  expect(await shown(MailDetail, 5)).toContain('#9 (deleted)')
  expect(await shown(SmsDetail, 7)).toContain('#8 (deleted)')
  setLocale('zh-CN')
  expect(await shown(MailForm, 5, 'field.messaging.mailTemplate.accountId')).toBe('#9（已删除）')
  expect(await shown(SmsForm, 7, 'field.messaging.smsTemplate.channelId')).toBe('#8（已删除）')
  wrapper = undefined
})
