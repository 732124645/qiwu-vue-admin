// The upload fields' size limit: the server's public param `storage.max_size_mb`, read once per
// page (here 50 MB); an explicit `maxSize` still wins. Unreadable → the 20 MB default (upload.spec).
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage } from 'element-plus'
import type { Component } from 'vue'
import FileUpload from '@/core/components/FileUpload.vue'
import ImageUpload from '@/core/components/ImageUpload.vue'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import { mockApi, ok } from './mock-api'

const MB = 1024 * 1024
const PARAM = '/settings/params/public/storage.max_size_mb'

const sized = (name: string, size: number) => {
  const f = new File(['x'], name, { type: 'application/pdf' })
  return Object.defineProperty(f, 'size', { value: size })
}
const field = (component: Component, props = {}) =>
  mount(component, {
    props: { modelValue: [], ...props },
    global: { plugins: [ElementPlus, i18n] },
    attachTo: document.body,
  })
async function pick(w: VueWrapper, f: File) {
  const input = w.find('input[type=file]')
  Object.defineProperty(input.element, 'files', { value: [f], configurable: true })
  await input.trigger('change')
  await flushPromises()
}

let error: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  setLocale('en-US')
  accessToken.value = 'at'
  error = vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

it('reads the server’s limit once: the hint and the check follow it; an explicit maxSize wins', async () => {
  const calls = mockApi({
    [`GET ${PARAM}`]: ok({ key: 'storage.max_size_mb', value: '50' }),
    'POST /storage/objects': ok({ id: 1, originalName: 'a.pdf' }),
  })
  const files = field(FileUpload)
  const images = field(ImageUpload)
  const own = field(FileUpload, { maxSize: 10 * MB })
  await flushPromises()
  expect(files.find('.file-upload__tip').text()).toContain('50 MB')
  expect(images.text()).toContain('50 MB')
  expect(own.find('.file-upload__tip').text()).toContain('10 MB')
  expect(calls.filter((c) => c.url === PARAM)).toHaveLength(1)

  // above the old 20 MB default, below the server's 50: sent
  await pick(files, sized('a.pdf', 30 * MB))
  expect(calls.filter((c) => c.method === 'post')).toHaveLength(1)
  expect(error).not.toHaveBeenCalled()
  // above the server's limit: refused before sending
  await pick(files, sized('b.pdf', 50 * MB + 1))
  expect(error).toHaveBeenLastCalledWith(
    expect.objectContaining({ message: '"b.pdf" is larger than 50 MB' }),
  )
  await pick(own, sized('c.pdf', 30 * MB))
  expect(error).toHaveBeenLastCalledWith(
    expect.objectContaining({ message: '"c.pdf" is larger than 10 MB' }),
  )
  expect(calls.filter((c) => c.method === 'post')).toHaveLength(1)
})
