// AreaCascader (platform/geo; see docs/design-notes.md#layering): el-cascader over GET /geo/areas/tree, v-model = the code
// path; the static tree is fetched once per page load (and again after a failure).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref } from 'vue'
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage } from 'element-plus'
import type { GeoAreaNode } from '@qiwu/shared'
import AreaCascader from '@/core/components/AreaCascader.vue'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import { fail, mockApi, ok } from './mock-api'

const AREAS: GeoAreaNode[] = [
  {
    code: '110000',
    name: 'Beijing',
    children: [
      {
        code: '110100',
        name: 'Beijing City',
        children: [
          { code: '110101', name: 'Dongcheng' },
          { code: '110102', name: 'Xicheng' },
        ],
      },
    ],
  },
  {
    code: '440000',
    name: 'Guangdong',
    children: [
      { code: '440300', name: 'Shenzhen', children: [{ code: '440305', name: 'Nanshan' }] },
    ],
  },
]

const picked = ref<string[] | null | undefined>(null)
const Host = defineComponent({
  setup: () => () =>
    h(AreaCascader, {
      modelValue: picked.value,
      'onUpdate:modelValue': (v: string[] | null | undefined) => (picked.value = v),
      clearable: true,
    }),
})
const wrappers: VueWrapper[] = []
async function mountHost() {
  const w = mount(Host, { global: { plugins: [ElementPlus, i18n] }, attachTo: document.body })
  wrappers.push(w)
  await flushPromises()
  return w
}
const body = () => new DOMWrapper(document.body)
async function clickNode(text: string) {
  const node = body()
    .findAll('.el-cascader-node')
    .find((n) => n.find('.el-cascader-node__label').text() === text)
  await node!.trigger('click')
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  picked.value = null
  vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
})
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.exists() && w.unmount())
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('AreaCascader', () => {
  it('fetches the tree once (again only after a failure) and picks a county as its code path', async () => {
    let down = true
    const calls = mockApi({
      'GET /geo/areas/tree': () => (down ? fail(500, 'A0500') : ok(AREAS)),
    })
    const failed = await mountHost()
    down = false
    const cascader = await mountHost()
    const cached = await mountHost()
    expect(calls.filter((c) => c.url === '/geo/areas/tree')).toHaveLength(2)
    failed.unmount()
    cached.unmount()
    expect(cascader.find('input').attributes('placeholder')).toBe('Select a region')

    await cascader.find('.el-cascader').trigger('click')
    await flushPromises()
    await clickNode('Guangdong')
    await clickNode('Shenzhen')
    await clickNode('Nanshan')
    expect(picked.value).toEqual(['440000', '440300', '440305'])
    expect(cascader.find('input').element.value).toBe('Guangdong / Shenzhen / Nanshan')

    picked.value = ['110000', '110100', '110102']
    await flushPromises()
    expect(cascader.find('input').element.value).toBe('Beijing / Beijing City / Xicheng')
  })
})
