// The SMS channel form shows the delivery-receipt callback URL once the channel has an id: the
// provider posts to /api/messaging/sms/receipt/<id>?token=<receipt secret>.
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import SmsChannelForm from '@/views/platform/messaging/sms-channel/form.vue'
import { mockApi, ok } from './mock-api'

const show = async (props: { id?: number }) => {
  const w = mount(SmsChannelForm, { props, global: { plugins: [ElementPlus, i18n] } })
  await flushPromises()
  return w
}

beforeEach(() => {
  setActivePinia(createPinia())
  accessToken.value = 'at'
  setLocale('en-US')
  mockApi({
    'GET /settings/dicts/messaging.sms_driver/entries': ok({ version: 0, entries: [] }),
    'GET /messaging/sms-channels/5': ok({ id: 5, driver: 'debug', name: 'Debug', enabled: true }),
  })
})
afterEach(() => setLocale('zh-CN'))

it('editing: the callback URL with this channel’s id, the secret left to append', async () => {
  const w = await show({ id: 5 })
  expect(w.text()).toContain(
    `Delivery-receipt callback URL for the provider (append the receipt secret): ${location.origin}/api/messaging/sms/receipt/5?token=`,
  )
})

it('adding: no id yet, so no URL, only when it shows', async () => {
  const w = await show({})
  expect(w.text()).not.toContain('/api/messaging/sms/receipt/')
  expect(w.text()).toContain('shows here once saved')
})
