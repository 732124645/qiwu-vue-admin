// MCP admin pages: the tool page (switches only with the modify permission, a switch saves and reloads,
// the endpoint URL on this origin) and the tenant's token page (revoke after a confirm, only live tokens,
// only with the revoke permission).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import type { AccessTokenAdminVo, McpToolVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import ToolPage from '@/views/platform/mcp/tool/index.vue'
import TokenPage from '@/views/platform/mcp/token/index.vue'
import { me, mockApi, ok } from './mock-api'

const TOOLS: McpToolVo[] = [
  {
    name: 'iam.me.get',
    title: 'Me',
    description: 'The signed-in user',
    kind: 'read',
    perm: null,
    enabled: true,
  },
  {
    name: 'demo.book.create',
    title: 'New book',
    description: 'Adds a book',
    kind: 'write',
    perm: 'demo.book.create',
    enabled: false,
  },
]
const AT = '2026-10-20T01:00:00.000Z'
const token = (id: number, extra: Partial<AccessTokenAdminVo> = {}): AccessTokenAdminVo => ({
  id,
  name: `agent ${id}`,
  tokenHint: 'ab12',
  tools: null,
  allowWrite: false,
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
  createdAt: AT,
  userId: 3,
  username: 'alice',
  displayName: 'Alice',
  ...extra,
})

let w: VueWrapper
async function show(component: object, perms: string[]) {
  useAuthStore().me = me(perms)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  await router.push('/')
  w = mount(component, {
    global: { plugins: [ElementPlus, i18n, router], directives: { perm: vPerm } },
    attachTo: document.body,
  })
  await flushPromises()
}
const t = (key: string) => i18n.global.t(key)

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
  vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
})
afterEach(() => {
  w?.unmount()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('mcp tool page', () => {
  it('shows the endpoint, the kinds and the permission; no switch without modify', async () => {
    mockApi({ 'GET /mcp/tools': ok(TOOLS) })
    await show(ToolPage, ['mcp.tool.browse'])
    expect((w.find('.mcp-tool__endpoint input').element as HTMLInputElement).value).toBe(
      `${location.origin}/api/mcp`,
    )
    const body = w.find('.el-table__body').text()
    expect(body).toContain(t('mcp.tool.anyUser'))
    expect(body).toContain('demo.book.create')
    expect(body).toContain(t('mcp.tool.kind.write'))
    expect(w.findAll('.el-table__body [role="switch"]')).toHaveLength(0)
    expect(body).toContain(t('mcp.tool.off'))
  })

  it('switches a tool off with the modify permission and reloads', async () => {
    let list = TOOLS
    const calls = mockApi({
      'GET /mcp/tools': () => ok(list),
      'PUT /mcp/tools/iam.me.get/enabled': () => {
        list = list.map((x) => (x.name === 'iam.me.get' ? { ...x, enabled: false } : x))
        return ok(null)
      },
    })
    await show(ToolPage, ['mcp.tool.browse', 'mcp.tool.modify'])
    const switches = w.findAll('.el-table__body [role="switch"]')
    expect(switches.map((s) => s.attributes('aria-checked'))).toEqual(['true', 'false'])
    await switches[0]!.trigger('click')
    await flushPromises()
    const put = calls.filter((c) => c.method === 'put')
    expect(put).toHaveLength(1)
    expect(JSON.parse(String(put[0]!.data))).toEqual({ enabled: false })
    expect(calls.filter((c) => c.method === 'get' && c.url === '/mcp/tools')).toHaveLength(2)
    expect(
      w.findAll('.el-table__body [role="switch"]').map((s) => s.attributes('aria-checked')),
    ).toEqual(['false', 'false'])
  })
})

describe('mcp token page', () => {
  const ROWS = [token(5), token(6, { revokedAt: AT })]

  it('revokes a live token after a confirm and reloads', async () => {
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const calls = mockApi({
      'GET /mcp/tokens': ok({ items: ROWS, total: 2 }),
      'POST /mcp/tokens/5/revoke': ok(null),
    })
    await show(TokenPage, ['mcp.token.browse', 'mcp.token.revoke'])
    expect(w.find('.el-table__body').text()).toContain('Alice (alice)')
    const buttons = w
      .findAll('.el-table__body button')
      .filter((b) => b.text() === t('menu.action.revoke'))
    // the revoked row's button stays disabled
    expect(buttons.map((b) => b.attributes('disabled') != null)).toContain(true)
    const live = buttons.find((b) => b.attributes('disabled') == null)!
    await live.trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledOnce()
    expect(calls.filter((c) => c.method === 'post').map((c) => c.url)).toEqual([
      '/mcp/tokens/5/revoke',
    ])
    expect(calls.filter((c) => c.method === 'get' && c.url === '/mcp/tokens')).toHaveLength(2)
  })

  it('sends nothing when the confirm is dismissed; no revoke button without the permission', async () => {
    vi.spyOn(ElMessageBox, 'confirm').mockRejectedValue('cancel')
    const calls = mockApi({ 'GET /mcp/tokens': ok({ items: ROWS, total: 2 }) })
    await show(TokenPage, ['mcp.token.browse', 'mcp.token.revoke'])
    const live = w
      .findAll('.el-table__body button')
      .find((b) => b.text() === t('menu.action.revoke') && b.attributes('disabled') == null)!
    await live.trigger('click')
    await flushPromises()
    expect(calls.filter((c) => c.method === 'post')).toHaveLength(0)
    w.unmount()

    await show(TokenPage, ['mcp.token.browse'])
    const shown = w
      .findAll('.el-table__body button')
      .filter((b) => b.text() === t('menu.action.revoke'))
      .filter((b) => (b.element as HTMLElement).style.display !== 'none')
    expect(shown).toHaveLength(0)
  })
})
