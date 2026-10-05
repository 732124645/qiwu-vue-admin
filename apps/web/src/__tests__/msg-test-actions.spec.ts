import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage } from 'element-plus'
import type { InboxTemplateVo, MailTemplateVo, SmsTemplateVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import MailSend from '@/views/platform/messaging/mail-template/test-send.vue'
import SmsSend from '@/views/platform/messaging/sms-template/test-send.vue'
import InboxSend from '@/views/platform/messaging/inbox-template/test.vue'
import MailAccounts from '@/views/platform/messaging/mail-account/index.vue'
import SmsChannels from '@/views/platform/messaging/sms-channel/index.vue'
import { fail, me, mockApi, ok } from './mock-api'

const mail = { id: 7, subject: 'Hello', body: 'Message' } as MailTemplateVo
const sms = { id: 8, body: 'Message' } as SmsTemplateVo
const inbox = { id: 9, paramNames: [] } as unknown as InboxTemplateVo
let page: VueWrapper
let error: ReturnType<typeof vi.spyOn>

async function show(
  component:
    typeof MailSend | typeof SmsSend | typeof InboxSend | typeof MailAccounts | typeof SmsChannels,
  props = {},
) {
  page = mount(component, {
    props,
    global: { plugins: [ElementPlus, i18n], directives: { perm: vPerm } },
    attachTo: document.body,
  })
  await flushPromises()
}

async function click(text: string) {
  const button = page.findAll('button').find((b) => b.text() === text)
  expect(button).toBeDefined()
  await button!.trigger('click')
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  useAuthStore().me = me(['*'])
  accessToken.value = 'at'
  setLocale('en-US')
  error = vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
  vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
})
afterEach(() => {
  page?.unmount()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('messaging test actions', () => {
  it('mail send shows one server 500 message without a fake id, while ok:false keeps the real id', async () => {
    mockApi({ 'POST /messaging/mail-templates/7/test': fail(500, 'A0500', 'Server broke') })
    await show(MailSend, { row: mail })
    await page.find('input[type="email"]').setValue('test@example.com')
    await click('Test send')
    expect(error).toHaveBeenCalledExactlyOnceWith({ message: 'Server broke', grouping: true })
    expect(error.mock.calls.flat().join(' ')).not.toContain('#—')
    error.mockClear()
    mockApi({ 'POST /messaging/mail-templates/7/test': ok({ ok: false, recordId: 123 }) })
    await click('Test send')
    expect(error).toHaveBeenCalledExactlyOnceWith('Test mail failed, record #123')
  })

  it('mail send shows one caller-owned 404 message', async () => {
    mockApi({ 'POST /messaging/mail-templates/7/test': fail(404, 'A0404', 'Template missing') })
    await show(MailSend, { row: mail })
    await page.find('input[type="email"]').setValue('test@example.com')
    await click('Test send')
    expect(error).toHaveBeenCalledExactlyOnceWith('Template missing')
  })

  it('SMS send shows one server message', async () => {
    mockApi({ 'POST /messaging/sms-templates/8/test': fail(500, 'A0500', 'SMS server broke') })
    await show(SmsSend, { row: sms })
    await page.find('input[type="tel"]').setValue('13800138000')
    await click('Test send')
    expect(error).toHaveBeenCalledExactlyOnceWith({ message: 'SMS server broke', grouping: true })
  })

  it('inbox send catches 404 and shows its message', async () => {
    mockApi({
      'POST /messaging/inbox-templates/9/test': fail(404, 'A0404', 'Inbox template missing'),
    })
    await show(InboxSend, { row: inbox })
    await click('Test send')
    expect(error).toHaveBeenCalledExactlyOnceWith('Inbox template missing')
  })

  it.each([
    [MailAccounts, 'mail-accounts', 'Test connection'],
    [SmsChannels, 'sms-channels', 'Test connection'],
  ])('%s connection test shows one 422 message', async (component, resource, label) => {
    const calls = mockApi({
      [`GET /messaging/${resource}`]: ok({
        items: [{ id: 5, name: 'Provider', enabled: true }],
        total: 1,
      }),
      [`POST /messaging/${resource}/5/test`]: fail(422, 'A0422', 'Connection rejected'),
      'GET /settings/dicts/messaging.mail_security/entries': ok({ entries: [] }),
      'GET /settings/dicts/messaging.sms_driver/entries': ok({ entries: [] }),
      'GET /settings/dicts/core.enabled/entries': ok({ entries: [] }),
    })
    await show(component)
    const button = page
      .find('.el-table__body .el-table__row')
      .findAll('button')
      .find((b) => b.text() === label)
    expect(button).toBeDefined()
    await button!.trigger('click')
    await flushPromises()
    expect(calls.map((c) => `${c.method} ${c.url}`)).toContain(`post /messaging/${resource}/5/test`)
    expect(error).toHaveBeenCalledExactlyOnceWith({
      message: 'Connection rejected',
      grouping: true,
    })
  })
})
