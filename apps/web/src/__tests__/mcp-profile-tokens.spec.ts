// Personal access tokens in the personal center: the tab only while the server answers the own-token list
// (404 while agent access is off), a new token shown once and gone after its dialog closes, revoking an
// own token after a confirm; and the OAuth2 client form leaving the agent scopes unticked by default.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import type { AccessTokenCreatedVo, AccessTokenVo, McpToolVo } from '@qiwu/shared'
import { dialogs } from '@/core/dialog'
import DialogHost from '@/core/dialog/DialogHost.vue'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import ClientForm from '@/views/platform/oauth/client/form.vue'
import AccessTokens from '@/views/profile/AccessTokens.vue'
import ProfileView from '@/views/profile/index.vue'
import { fail, me, mockApi, ok, type Route } from './mock-api'

const AT = '2026-10-20T01:00:00.000Z'
const SECRET = `qwmcp_${'x'.repeat(43)}`
const row = (id: number, extra: Partial<AccessTokenVo> = {}): AccessTokenVo => ({
  id,
  name: `agent ${id}`,
  tokenHint: 'xxxx',
  tools: null,
  allowWrite: false,
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
  createdAt: AT,
  ...extra,
})
const TOOLS: McpToolVo[] = [
  { name: 'iam.me.get', title: 'Me', description: '', kind: 'read', perm: null, enabled: true },
  {
    name: 'demo.book.create',
    title: 'New book',
    description: '',
    kind: 'write',
    perm: 'demo.book.create',
    enabled: true,
  },
]
const t = (key: string) => i18n.global.t(key)

let w: VueWrapper
async function show(component: object, routes: Record<string, Route>, perms = ['*']) {
  const calls = mockApi(routes)
  useAuthStore().me = me(perms)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  await router.push('/')
  // the page with the dialog host beside it, as in App.vue
  const Root = defineComponent({ render: () => [h(component), h(DialogHost)] })
  w = mount(Root, {
    global: {
      plugins: [ElementPlus, i18n, router],
      directives: { perm: vPerm },
      stubs: { transition: false },
    },
    attachTo: document.body,
  })
  await flushPromises()
  return calls
}
// the newest dialog (an older one may still be closing)
const dialog = () => [...document.querySelectorAll<HTMLElement>('.el-dialog')].at(-1)!
const buttonIn = (root: ParentNode, text: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!
async function type(root: ParentNode, name: string, value: string) {
  const input = root.querySelector<HTMLInputElement>(`input[name="${name}"]`)!
  input.value = value
  input.dispatchEvent(new Event('input'))
  await flushPromises()
}
const inputValues = () => [...document.querySelectorAll('input')].map((i) => i.value)

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
  vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
})
afterEach(() => {
  w?.unmount()
  dialogs.splice(0)
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('personal center access tokens', () => {
  const tabs = () => w.findAll('.el-tabs__item').map((x) => x.text())

  it('shows the tab only while the own-token list answers', async () => {
    await show(ProfileView, { 'GET /mcp/my-tokens': fail(404, 'A0440') })
    expect(tabs()).not.toContain(t('menu.mcp.token'))
    w.unmount()
    await show(ProfileView, { 'GET /mcp/my-tokens': ok([]) })
    expect(tabs()).toContain(t('menu.mcp.token'))
  })

  it('creates a token, shows it once, and keeps it nowhere after the dialog closes', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    let list: AccessTokenVo[] = []
    const created: AccessTokenCreatedVo = { ...row(9, { tools: ['iam.me.get'] }), token: SECRET }
    const calls = await show(
      AccessTokens,
      {
        'GET /mcp/my-tokens': () => ok(list),
        'GET /mcp/my-tools': ok(TOOLS),
        'POST /mcp/my-tokens': () => {
          list = [row(9, { tools: ['iam.me.get'] })]
          return ok(created)
        },
        // a user without any perm of the platform's tool page picks from the own tool list
      },
      [],
    )
    await buttonIn(document, t('mcp.token.create')).click()
    await flushPromises()
    const form = dialog()
    // nothing picked = every tool
    expect(calls.some((c) => c.url === '/mcp/my-tools')).toBe(true)
    expect(calls.some((c) => c.url === '/mcp/tools')).toBe(false)
    expect(form.querySelector('.el-select')).not.toBeNull()
    expect(form.textContent).toContain(t('mcp.token.toolsHint'))
    await type(form, 'name', 'my agent')
    await type(form, 'currentPassword', 'Secret#123')
    await buttonIn(form.querySelector('.qw-dialog-footer')!, t('mcp.token.create')).click()
    await flushPromises()

    const post = calls.filter((c) => c.method === 'post')
    expect(post).toHaveLength(1)
    expect(JSON.parse(String(post[0]!.data))).toEqual({
      name: 'my agent',
      expiresInDays: 30,
      tools: null,
      allowWrite: false,
      currentPassword: 'Secret#123',
    })
    // the result dialog: the token in full with a copy button and the warning
    await vi.waitFor(() => expect(inputValues()).toContain(SECRET))
    const result = dialog()
    expect(result.textContent).toContain(t('mcp.token.once'))
    result.querySelector<HTMLButtonElement>(`button[aria-label="${t('mcp.copy')}"]`)!.click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(SECRET)

    await buttonIn(result, t('mcp.token.saved')).click()
    await flushPromises()
    await vi.waitFor(() => expect(dialogs).toHaveLength(0))
    expect(inputValues()).not.toContain(SECRET)
    expect(document.body.innerHTML).not.toContain(SECRET)
    // the list shows the new row by its hint only
    expect(w.find('.el-table__body').text()).toContain('agent 9')
  })

  it('revokes an own live token after a confirm', async () => {
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const calls = await show(AccessTokens, {
      'GET /mcp/my-tokens': ok([row(4), row(3, { expiresAt: '2020-01-01T00:00:00.000Z' })]),
      'POST /mcp/my-tokens/4/revoke': ok(null),
    })
    const buttons = w
      .findAll('.el-table__body button')
      .filter((b) => b.text() === t('menu.action.revoke'))
    // the expired one cannot be revoked again
    expect(buttons.map((b) => b.attributes('disabled') != null)).toEqual([false, true])
    expect(w.find('.el-table__body').text()).toContain(t('mcp.token.state.expired'))
    await buttons[0]!.trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledOnce()
    expect(calls.filter((c) => c.method === 'post').map((c) => c.url)).toEqual([
      '/mcp/my-tokens/4/revoke',
    ])
  })
})

describe('oauth client form', () => {
  it('leaves the agent scopes unticked by default', async () => {
    await show(ClientForm, {})
    const boxes = [...document.querySelectorAll<HTMLInputElement>('.el-checkbox input')]
    const checked = (value: string) => boxes.filter((b) => b.value === value).map((b) => b.checked)
    expect(checked('user.read')[0]).toBe(true)
    expect(checked('mcp')).toEqual([false])
    expect(checked('mcp.write')).toEqual([false])
    expect(document.body.textContent).toContain(t('oauth.scope.mcp_write'))
  })
})
