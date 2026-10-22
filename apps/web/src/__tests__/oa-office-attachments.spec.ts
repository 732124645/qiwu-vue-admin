import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import ElementPlus from 'element-plus'
import type { FsObjectVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import OaAttachments from '@/views/oa/components/OaAttachments.vue'

const calls = vi.hoisted(() => ({ metadata: vi.fn<(id: number) => Promise<FsObjectVo>>() }))
vi.mock('@/api/platform/storage/object', () => ({ storageApi: calls }))
const pending = ref<{ uid: number }[]>([])
const upload = defineComponent({
  name: 'FileUpload',
  props: ['modelValue', 'bizTag', 'disabled'],
  emits: ['update:modelValue'],
  setup(_props, { expose }) {
    expose({ pending })
  },
  template:
    '<div class="upload-stub"><span v-for="file in modelValue" :key="file.id">{{ file.originalName }}</span></div>',
})
const file = (id: number): FsObjectVo => ({
  id,
  originalName: `request-${id}.pdf`,
  mime: 'application/pdf',
  size: 100,
  isPublic: false,
  bizTag: 'oa.attachment',
  url: null,
  createdAt: '2026-10-22T01:00:00.000Z',
})
let wrapper: VueWrapper
const open = (ids: number[] = [], readonly = false) =>
  (wrapper = mount(OaAttachments, {
    props: { modelValue: ids, readonly },
    global: {
      plugins: [ElementPlus, i18n],
      stubs: { FileUpload: upload },
    },
  }))
beforeEach(() => {
  setLocale('en-US')
  pending.value = []
  calls.metadata.mockReset().mockImplementation(async (id: number) => file(id))
})
afterEach(() => wrapper?.unmount())

it('loads existing file names through business metadata and writes only completed object IDs', async () => {
  open([4])
  await flushPromises()
  expect(calls.metadata).toHaveBeenCalledExactlyOnceWith(4)
  expect(wrapper.text()).toContain('request-4.pdf')
  const child = wrapper.findComponent(upload)
  expect(child.props('bizTag')).toBe('oa.attachment')
  child.vm.$emit('update:modelValue', [file(4), file(5)])
  await flushPromises()
  expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([[4, 5]])
  expect(calls.metadata).toHaveBeenCalledTimes(1)
})

it('keeps a metadata failure blocked until a successful explicit retry', async () => {
  calls.metadata.mockRejectedValueOnce(new Error('Denied'))
  open([7])
  await flushPromises()
  expect(wrapper.emitted('busy')?.at(-1)).toEqual([true])
  expect(wrapper.findComponent(upload).props('disabled')).toBe(true)
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(calls.metadata).toHaveBeenCalledTimes(2)
  expect(wrapper.emitted('busy')?.at(-1)).toEqual([false])
  expect(wrapper.text()).toContain('request-7.pdf')
})

it('reports pending uploads so a parent cannot submit an incomplete file list', async () => {
  open()
  await flushPromises()
  expect(wrapper.emitted('busy')?.at(-1)).toEqual([false])
  pending.value.push({ uid: 1 })
  await flushPromises()
  expect(wrapper.emitted('busy')?.at(-1)).toEqual([true])
  pending.value = []
  await flushPromises()
  expect(wrapper.emitted('busy')?.at(-1)).toEqual([false])
})

it('renders existing attachments read-only without presenting upload or removal controls', async () => {
  open([9], true)
  await flushPromises()
  expect(wrapper.findComponent(upload).props('disabled')).toBe(true)
  expect(wrapper.text()).toContain('request-9.pdf')
})

it('discards a delayed metadata response after the document attachment IDs change', async () => {
  let finish!: (value: FsObjectVo) => void
  calls.metadata.mockImplementation((id: number) =>
    id === 1
      ? new Promise<FsObjectVo>((resolve) => {
          finish = resolve
        })
      : Promise.resolve(file(id)),
  )
  open([1])
  await wrapper.setProps({ modelValue: [2] })
  await flushPromises()
  expect(wrapper.text()).toContain('request-2.pdf')
  finish(file(1))
  await flushPromises()
  expect(wrapper.text()).toContain('request-2.pdf')
  expect(wrapper.text()).not.toContain('request-1.pdf')
  expect(wrapper.emitted('busy')?.at(-1)).toEqual([false])
})
