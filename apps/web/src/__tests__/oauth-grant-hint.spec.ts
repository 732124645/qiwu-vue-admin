// OAuth2 client form: while multi-tenancy is on (`/me.tenant`) the grant types say that client credentials
// serve the platform's own integrations only; off, no such note.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import ClientForm from '@/views/platform/oauth/client/form.vue'
import { me, mockApi } from './mock-api'

const HINT = 'oauth.client.credentialsHint'
let form: VueWrapper
beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  mockApi({})
})
afterEach(() => {
  form.unmount()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

async function open(tenant: boolean) {
  useAuthStore().me = {
    ...me(['*']),
    ...(tenant && {
      tenant: {
        id: 1,
        code: 'default',
        name: 'seed.tenant.default',
        brandName: null,
        logoUrl: null,
        acting: false,
      },
    }),
  }
  form = mount(ClientForm, { global: { plugins: [ElementPlus, i18n] } })
  await flushPromises()
}

describe('oauth client form', () => {
  it('notes that client credentials are the platform’s only while multi-tenancy is on', async () => {
    await open(true)
    expect(form.text()).toContain(i18n.global.t(HINT))
    form.unmount()
    await open(false)
    expect(form.text()).not.toContain(i18n.global.t(HINT))
  })
})
