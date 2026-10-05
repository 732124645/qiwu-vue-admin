// Regions page (platform/geo): the division tree rendered a level at a time from one fetch, the IP
// lookup (validated like the server, "unknown" when nothing is known) and the AreaCascader preview.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import type { GeoAreaNode } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import GeoPage from '@/views/platform/geo/area/index.vue'
import { me, mockApi, ok, type Route } from './mock-api'

const AREAS: GeoAreaNode[] = [
  { code: '110000', name: 'Beijing', children: [{ code: '110100', name: 'Beijing City' }] },
  {
    code: '440000',
    name: 'Guangdong',
    children: [
      { code: '440300', name: 'Shenzhen', children: [{ code: '440305', name: 'Nanshan' }] },
    ],
  },
]
const KNOWN = { ip: '8.8.8.8', country: 'US', province: null, city: null, isp: 'Level3' }
const NOTHING = { ip: '10.0.0.1', country: null, province: null, city: null, isp: null }

function backend(extra: Record<string, Route> = {}) {
  return mockApi({
    'GET /geo/areas/tree': ok(AREAS),
    'GET /geo/areas/by-ip': (c) => ok(c.params?.ip === '8.8.8.8' ? KNOWN : NOTHING),
    ...extra,
  })
}

let page: VueWrapper
async function mountPage(perms = ['*']) {
  useAuthStore().me = me(perms)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  await router.push('/')
  page = mount(GeoPage, {
    global: { plugins: [ElementPlus, i18n, router], directives: { perm: vPerm } },
    attachTo: document.body,
  })
  await flushPromises()
}
const labels = () => page.findAll('.geo-area__tree .el-tree-node__content').map((n) => n.text())
const node = (name: string) =>
  page.findAll('.geo-area__tree .el-tree-node__content').find((n) => n.text().startsWith(name))!
async function lookup(ip: string) {
  await page.find('input[name="ip"]').setValue(ip)
  await page.find('.geo-area__lookup').trigger('submit')
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
})
afterEach(() => {
  page.unmount()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('regions page', () => {
  it('opens the tree a level at a time down to the counties, from one fetch', async () => {
    const calls = backend()
    await mountPage()
    expect(labels()).toEqual(['Beijing110000', 'Guangdong440000'])
    await node('Guangdong').trigger('click')
    await flushPromises()
    await node('Shenzhen').trigger('click')
    await flushPromises()
    expect(labels()).toEqual([
      'Beijing110000',
      'Guangdong440000',
      'Shenzhen440300',
      'Nanshan440305',
    ])
    // a county is a leaf
    expect(node('Nanshan').find('.el-tree-node__expand-icon').classes()).toContain('is-leaf')
    expect(calls.filter((c) => c.url === '/geo/areas/tree')).toHaveLength(1)
  })

  it('looks up an IP after checking it, and says "unknown" when nothing is known', async () => {
    const calls = backend()
    await mountPage()
    await lookup('8.8.8')
    expect(page.find('.geo-area__lookup .el-form-item').classes()).toContain('is-error')
    expect(calls.some((c) => c.url === '/geo/areas/by-ip')).toBe(false)

    await lookup(' 8.8.8.8 ')
    expect(calls.at(-1)?.params).toEqual({ ip: '8.8.8.8' })
    expect(page.find('.geo-area__place').text()).toBe('US')
    expect(page.find('.el-descriptions').text()).toContain('Level3')

    await lookup('10.0.0.1')
    expect(page.find('.geo-area__place').text()).toBe('Unknown')
  })

  it('previews AreaCascader with its value', async () => {
    backend()
    await mountPage()
    expect(page.find('.geo-area__value code').text()).toBe('—')
    page.findComponent({ name: 'AreaCascader' }).vm.$emit('update:modelValue', ['110000', '110100'])
    await flushPromises()
    expect(page.find('.geo-area__value code').text()).toBe('110000, 110100')
  })

  it('hides the lookup without geo.area.browse', async () => {
    backend()
    await mountPage([])
    expect(page.find('.geo-area__lookup').isVisible()).toBe(false)
  })
})
