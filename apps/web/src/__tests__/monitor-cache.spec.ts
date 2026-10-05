// Cache monitor page (monitor/cache): namespaces → keys → value (JSON pretty-printed,
// masked values never shown), clearing a key / a namespace / all after a confirm, perms.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import type { CacheNamespaceVo } from '@qiwu/shared'
import CodeViewer from '@/core/components/CodeViewer.vue'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import CachePage from '@/views/platform/monitor/cache/index.vue'
import { me, mockApi, ok, type Route } from './mock-api'

const NS: CacheNamespaceVo[] = [
  { name: 'authSession', prefix: 'auth:sess:', clearable: false, masked: true },
  { name: 'dict', prefix: 'dict:', clearable: true, masked: false },
  { name: 'newThing', prefix: 'new:', clearable: true, masked: false },
]
const q = (c: { params?: Record<string, string> }) => new URLSearchParams(c.params).toString()

function backend(extra: Record<string, Route> = {}) {
  return mockApi({
    'GET /monitor/cache/namespaces': ok(NS),
    'GET /monitor/cache/keys': (c) =>
      c.params?.ns === 'dict'
        ? ok({ keys: ['dict:iam.gender', 'dict:core.enabled'], truncated: true })
        : ok({ keys: ['auth:sess:9f2c'], truncated: false }),
    'GET /monitor/cache/value': (c) =>
      c.params?.key === 'auth:sess:9f2c'
        ? ok({ key: 'auth:sess:9f2c', type: 'string', ttl: 100, masked: true, value: null })
        : ok({ key: c.params?.key, type: 'string', ttl: -1, masked: false, value: '{"a":[1,2]}' }),
    'DELETE /monitor/cache/keys': (c) => ok({ deleted: c.params?.ns ? 5 : 1 }),
    'DELETE /monitor/cache/all-registered': ok({ deleted: 9 }),
    ...extra,
  })
}
const deletes = (calls: { method?: string; url?: string; params?: Record<string, string> }[]) =>
  calls.filter((c) => c.method === 'delete').map((c) => `${c.url}?${q(c)}`)

let page: VueWrapper
async function mountPage(perms = ['*']) {
  useAuthStore().me = me(perms)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  await router.push('/')
  page = mount(CachePage, {
    global: { plugins: [ElementPlus, i18n, router], directives: { perm: vPerm } },
    attachTo: document.body,
  })
  await flushPromises()
}
const nsRows = () => page.findAll('.cache-monitor__ns .el-table__body .el-table__row')
const keyRows = () => page.findAll('.cache-monitor__keys .el-table__body .el-table__row')
const button = (text: string, root: { findAll: VueWrapper['findAll'] } = page) =>
  root.findAll('button').find((b) => b.text() === text)

let confirm: ReturnType<typeof vi.spyOn>
let success: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
  success = vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
})
afterEach(() => {
  page.unmount()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('cache monitor', () => {
  it('lists the namespaces, their keys (filtered here) and a value pretty-printed', async () => {
    const calls = backend()
    await mountPage()
    expect(nsRows().map((r) => r.find('.cache-monitor__ns-name').text())).toEqual([
      'Sessions',
      'Dictionaries',
      'newThing', // no page words yet: the registry name
    ])
    await nsRows()[1]!.trigger('click')
    await flushPromises()
    expect(calls.at(-1)?.params).toEqual({ ns: 'dict' })
    expect(page.find('.cache-monitor__keys h2').text()).toBe('Keys of Dictionaries 2')
    expect(page.text()).toContain('Only the first 1,000 keys are listed.')
    expect(keyRows().map((r) => r.find('td').text())).toEqual([
      'dict:iam.gender',
      'dict:core.enabled',
    ])
    await page.find('input[name="keyword"]').setValue('GENDER')
    expect(keyRows()).toHaveLength(1)

    await keyRows()[0]!.trigger('click')
    await flushPromises()
    expect(calls.at(-1)?.params).toEqual({ key: 'dict:iam.gender' })
    expect(page.getComponent(CodeViewer).props('files')).toEqual([
      { path: 'value.json', content: '{\n  "a": [\n    1,\n    2\n  ]\n}', language: 'json' },
    ])
    await vi.waitFor(() =>
      expect(page.find('.code-viewer__line span').attributes('style')).toContain('--shiki-light'),
    )
    const files = page.getComponent(CodeViewer).props('files')
    await page.find('input[name="keyword"]').setValue('enabled')
    expect(keyRows()).toHaveLength(1)
    expect(page.getComponent(CodeViewer).props('files')).toBe(files)
    expect(page.find('.cache-monitor__value').text()).toContain('No expiry')
    setLocale('zh-CN')
    await flushPromises()
    expect(page.getComponent(CodeViewer).props('files')).toBe(files)
  })

  it('never shows a masked value and offers no clearing of a protected namespace', async () => {
    backend({
      'GET /monitor/cache/value': ok({
        key: 'auth:sess:9f2c',
        type: 'string',
        ttl: 100,
        masked: true,
        value: 'secret-sentinel',
      }),
    })
    await mountPage()
    expect(button('Clear', nsRows()[0]!)).toBeUndefined()
    expect(button('Clear', nsRows()[1]!)).toBeDefined()
    await nsRows()[0]!.trigger('click')
    await flushPromises()
    expect(button('Delete', keyRows()[0]!)).toBeUndefined()
    await keyRows()[0]!.trigger('click')
    await flushPromises()
    expect(page.findComponent(CodeViewer).exists()).toBe(false)
    expect(page.text()).not.toContain('secret-sentinel')
    expect(page.text()).toContain('This value holds secrets and is never shown.')
  })

  it.each([
    [{ a: [1, 2] }, '{\n  "a": [\n    1,\n    2\n  ]\n}'],
    [[1, null], '[\n  1,\n  null\n]'],
    [null, 'null'],
    ['', ''],
    ['not JSON <script>alert(1)</script>', 'not JSON <script>alert(1)</script>'],
    ['{"html":"<img src=x onerror=alert(1)>"}', '{\n  "html": "<img src=x onerror=alert(1)>"\n}'],
  ])('keeps the unmasked value %j as read-only text', async (value, content) => {
    backend({
      'GET /monitor/cache/value': ok({
        key: 'dict:iam.gender',
        type: 'string',
        ttl: -1,
        masked: false,
        value,
      }),
    })
    await mountPage()
    await nsRows()[1]!.trigger('click')
    await flushPromises()
    await keyRows()[0]!.trigger('click')
    await flushPromises()
    const viewer = page.getComponent(CodeViewer)
    expect(viewer.props('files')).toEqual([{ path: 'value.json', content, language: 'json' }])
    expect(
      viewer
        .findAll('.code-viewer__line')
        .map((line) =>
          line
            .findAll('span')
            .map((token) => token.element.textContent)
            .join(''),
        )
        .join('\n'),
    ).toBe(content)
    expect(viewer.findAll('input, textarea, [contenteditable], img, script')).toHaveLength(0)
    expect(viewer.find('.el-tree').exists()).toBe(false)
  })

  it('clears a key, a namespace or every namespace after asking, then reloads the keys', async () => {
    const calls = backend()
    await mountPage()
    await nsRows()[1]!.trigger('click')
    await flushPromises()
    await button('Delete', keyRows()[0]!)!.trigger('click')
    await flushPromises()
    expect(confirm.mock.calls[0]?.[0]).toBe('Delete the key dict:iam.gender?')
    expect(success).toHaveBeenLastCalledWith('1 key(s) deleted')

    await button('Clear', nsRows()[1]!)!.trigger('click')
    await flushPromises()
    expect(confirm.mock.calls[1]?.[0]).toBe(
      'Delete every key of “Dictionaries”? The app rebuilds them when it needs them.',
    )
    expect(success).toHaveBeenLastCalledWith('5 key(s) deleted')

    await button('Clear all namespaces')!.trigger('click')
    await flushPromises()
    expect(success).toHaveBeenLastCalledWith('9 key(s) deleted')

    expect(deletes(calls)).toEqual([
      '/monitor/cache/keys?key=dict%3Aiam.gender',
      '/monitor/cache/keys?ns=dict',
      '/monitor/cache/all-registered?',
    ])
    // the keys reload after each
    expect(calls.filter((c) => c.url === '/monitor/cache/keys' && c.method === 'get')).toHaveLength(
      4,
    )

    confirm.mockRejectedValueOnce('cancel')
    const before = calls.length
    await button('Clear all namespaces')!.trigger('click')
    await flushPromises()
    expect(calls).toHaveLength(before)
  })

  it('shows no clearing without monitor.cache.remove', async () => {
    backend()
    await mountPage(['monitor.cache.browse'])
    expect(button('Clear all namespaces')?.isVisible()).toBe(false)
    expect(button('Clear', nsRows()[1]!)).toBeUndefined()
    await nsRows()[1]!.trigger('click')
    await flushPromises()
    expect(button('Delete', keyRows()[0]!)).toBeUndefined()
  })
})
