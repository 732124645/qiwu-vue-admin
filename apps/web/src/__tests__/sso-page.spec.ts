// The /sso consent page: its query goes to /api/oauth2/authorize as received; the
// browser only ever leaves for the server's http(s) `redirectTo`; an invalid request stays on the page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { i18n, setLocale } from '@/core/i18n'
import SsoView from '@/views/sso/index.vue'
import { fail, mockApi, ok, type Route } from './mock-api'

// encoded as a third party sends it: a re-encoded query (`state=s+1`, a bare redirect_uri) misses the mock
const Q =
  '?response_type=code&client_id=crm&redirect_uri=https%3A%2F%2Fcrm.example.com%2Fcb&state=s%201' +
  `&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256`
const AUTHORIZE = `/oauth2/authorize${Q}`
const CB = 'https://crm.example.com/cb?code=c1&state=s+1'
const preview = (pending: string[]) =>
  ok({ client: { clientId: 'crm', name: 'CRM', logoUrl: null }, scopes: ['user.read'], pending })

let assign: ReturnType<typeof vi.fn<(url: string | URL) => void>>

async function page(get: Route, post: Route = ok({ redirectTo: CB })) {
  const calls = mockApi({ [`GET ${AUTHORIZE}`]: get, [`POST ${AUTHORIZE}`]: post })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/sso', component: SsoView },
      { path: '/', component: { template: '<div />' } },
      { path: '/login', component: { template: '<div />' } },
    ],
  })
  await router.push(`/sso${Q}`)
  const wrapper = mount(SsoView, {
    global: { plugins: [createPinia(), router, i18n, ElementPlus] },
  })
  await flushPromises()
  const sent = () => calls.map((c) => `${c.method?.toUpperCase()} ${c.data ?? ''}`.trim())
  return { wrapper, sent, router }
}

const button = (wrapper: Awaited<ReturnType<typeof page>>['wrapper'], text: string) =>
  wrapper.findAll('button').find((b) => b.text() === text)!

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  assign = vi.fn<(url: string | URL) => void>()
  vi.spyOn(location, 'assign').mockImplementation(assign)
})
afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('/sso consent page', () => {
  it('nothing pending: approves at once with the query as received, leaves for redirectTo', async () => {
    const { sent } = await page(preview([]))
    expect(sent()).toEqual(['GET', 'POST {"approve":true}'])
    expect(assign).toHaveBeenCalledWith(CB)
  })

  it('consent: the client, its scopes and where it leads; deny posts approve=false', async () => {
    const { wrapper, sent } = await page(preview(['user.read']))
    expect(wrapper.text()).toContain('CRM wants to access your account:')
    expect(wrapper.text()).toContain(i18n.global.t('oauth.scope.user_read'))
    expect(wrapper.text()).toContain(
      'After authorization, you will be redirected to crm.example.com',
    )
    expect(sent()).toEqual(['GET'])
    await button(wrapper, 'Deny').trigger('click')
    await flushPromises()
    expect(sent()).toEqual(['GET', 'POST {"approve":false}'])
    expect(assign).toHaveBeenCalledWith(CB)
  })

  it('never follows an answer that is not http(s)', async () => {
    const { wrapper } = await page(preview([]), ok({ redirectTo: 'javascript:alert(1)' }))
    expect(assign).not.toHaveBeenCalled()
    expect(wrapper.find('.el-alert').text()).toContain('The authorization request is not valid')
  })

  it('an invalid request: the server’s message on the page, no POST, no redirect', async () => {
    const { wrapper, sent } = await page(fail(400, 'B4001', 'Unknown client'))
    expect(wrapper.find('.el-alert').text()).toContain('Unknown client')
    expect(sent()).toEqual(['GET'])
    expect(assign).not.toHaveBeenCalled()
    expect(wrapper.findAll('button').map((b) => b.text())).not.toContain('Allow')
  })

  it('the session ended meanwhile: to sign-in, then back to this request', async () => {
    const { router } = await page(fail(401, 'A0410'))
    expect(router.currentRoute.value.path).toBe('/login')
    expect(router.currentRoute.value.query.redirect).toBe(`/sso${Q}`)
    expect(assign).not.toHaveBeenCalled()
  })
})
