// Direct upload (see docs/design-notes.md#storage): the upload fields' `direct` switch = presign → PUT straight to the storage
// → confirm; off = the server upload. The app's requests go to the fake backend, the PUT to a fake storage
// host on the bare axios instance (the one the app never configures).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Component } from 'vue'
import axios, { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage } from 'element-plus'
import type { FsObjectVo, FsPresignVo } from '@qiwu/shared'
import FileUpload from '@/core/components/FileUpload.vue'
import ImageUpload from '@/core/components/ImageUpload.vue'
import { uploadMaxSize } from '@/core/composables/use-upload'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import { fail, mockApi, ok, type Route } from './mock-api'

const KEY = '2026/09/28/0b7f6a0e-3c1d-4f5e-9a2b-8c7d6e5f4a3b.pdf'
const SIGNED: FsPresignVo = {
  key: KEY,
  url: `https://qw-files.s3.example.com/${KEY}?X-Amz-Signature=abc`,
  headers: { 'Content-Type': 'application/pdf' },
  expiresAt: '2026-09-28T01:15:00.000Z',
}
const stored = (name: string): FsObjectVo => ({
  id: 7,
  originalName: name,
  mime: 'application/pdf',
  size: 4,
  url: null,
  isPublic: false,
  bizTag: 'attachment',
  createdAt: '2026-09-28T01:00:00.000Z',
})
const file = (name: string, type: string) => new File(['%PDF'], name, { type })
const json = (c: InternalAxiosRequestConfig | undefined) => JSON.parse(String(c?.data)) as unknown

/** The fake storage host: answers every PUT with `status` after reporting half the bytes sent. */
function storageHost(status = 200) {
  const puts: InternalAxiosRequestConfig[] = []
  axios.defaults.adapter = (async (config) => {
    puts.push(config)
    config.onUploadProgress?.({ loaded: 2, total: 4, bytes: 2, lengthComputable: true })
    const response = { data: '', status, statusText: String(status), headers: {}, config }
    if (status >= 400)
      throw new AxiosError(`status ${status}`, 'ERR_BAD_REQUEST', config, {}, response)
    return response
  }) as AxiosAdapter
  return puts
}

function backend(extra: Record<string, Route> = {}) {
  return mockApi({
    'POST /storage/objects/presign': ok(SIGNED),
    'POST /storage/objects/confirm': (c) =>
      ok(stored(((json(c) as { key: string }).key === KEY && 'a.pdf') || '?')),
    'POST /storage/objects': ok({ ...stored('server.pdf'), id: 8 }),
    ...extra,
  })
}

async function pick(w: VueWrapper, ...files: File[]) {
  const input = w.find('input[type=file]')
  Object.defineProperty(input.element, 'files', { value: files, configurable: true })
  await input.trigger('change')
  await flushPromises()
}

function withModel(component: Component, props = {}) {
  const w: VueWrapper = mount(component, {
    props: {
      modelValue: [],
      'onUpdate:modelValue': (v: unknown) => w.setProps({ modelValue: v }),
      ...props,
    },
    global: { plugins: [ElementPlus, i18n] },
    attachTo: document.body,
  })
  return w
}
const modelOf = (w: VueWrapper) => (w.props() as { modelValue: FsObjectVo[] }).modelValue

const bareAdapter = axios.defaults.adapter
let error: ReturnType<typeof vi.spyOn>
// the server's upload limit is read once per page: unreadable here (404), the default applies
beforeAll(async () => {
  mockApi({})
  await uploadMaxSize()
})
beforeEach(() => {
  setLocale('en-US')
  accessToken.value = 'at'
  error = vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
})
afterEach(() => {
  axios.defaults.adapter = bareAdapter
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('direct upload', () => {
  it('presigns, PUTs the bytes to the storage with only the signed headers, then confirms', async () => {
    const calls = backend()
    const puts = storageHost()
    const w = withModel(FileUpload, { direct: true })
    const pdf = file('a.pdf', 'application/pdf')
    await pick(w, pdf)

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'post /storage/objects/presign',
      'post /storage/objects/confirm',
    ])
    expect(json(calls[0])).toEqual({
      filename: 'a.pdf',
      size: 4,
      mime: 'application/pdf',
      bizTag: 'attachment',
    })
    expect(json(calls[1])).toEqual({ key: KEY })
    // the app's own calls carry the session; the PUT to the storage carries nothing of it
    expect(calls[0]?.headers.Authorization).toBe('Bearer at')
    expect(puts).toHaveLength(1)
    const put = puts[0]!
    expect(put).toMatchObject({ method: 'put', url: SIGNED.url, data: pdf })
    expect(put.baseURL).toBeUndefined()
    expect(put.withCredentials).toBeFalsy()
    expect(put.headers['Content-Type']).toBe('application/pdf')
    for (const header of ['Authorization', 'Accept-Language', 'X-Request-Id', 'X-Timezone'])
      expect(put.headers[header]).toBeUndefined()

    expect(modelOf(w).map((o) => [o.id, o.originalName])).toEqual([[7, 'a.pdf']])
    expect(error).not.toHaveBeenCalled()
  })

  it('shows the PUT progress until the confirm answers; a file without a type is sent as bytes', async () => {
    let confirm = (_reply: ReturnType<typeof ok>) => {}
    const calls = backend({
      'POST /storage/objects/confirm': () => new Promise((r) => (confirm = r)),
    })
    storageHost()
    const w = withModel(FileUpload, { direct: true })
    await pick(w, file('notes', ''))
    expect((json(calls[0]) as { mime: string }).mime).toBe('application/octet-stream')
    expect(w.find('[aria-busy="true"]').text()).toContain('50%')

    confirm(ok(stored('notes')))
    await flushPromises()
    expect(w.find('[aria-busy="true"]').exists()).toBe(false)
    expect(modelOf(w).map((o) => o.originalName)).toEqual(['notes'])
  })

  it('a PUT the storage refuses shows one generic message, never its answer, and is not confirmed', async () => {
    const calls = backend()
    storageHost(403)
    const w = withModel(FileUpload, { direct: true })
    await pick(w, file('a.pdf', 'application/pdf'))

    expect(calls.map((c) => c.url)).toEqual(['/storage/objects/presign'])
    expect(error).toHaveBeenCalledExactlyOnceWith(
      'The file could not be uploaded to the storage service. Try again, or ask an administrator to check the storage settings.',
    )
    expect(modelOf(w)).toEqual([])
    expect(w.find('[aria-busy="true"]').exists()).toBe(false)
  })

  it('a refused presign (no S3 primary storage) or confirm shows the server’s message once, nothing is PUT', async () => {
    backend({
      'POST /storage/objects/presign': fail(
        422,
        'C1005',
        'Direct upload needs an S3 primary storage',
      ),
    })
    const puts = storageHost()
    const w = withModel(FileUpload, { direct: true })
    await pick(w, file('a.pdf', 'application/pdf'))
    expect(puts).toHaveLength(0)
    expect(error.mock.calls).toEqual([
      [{ message: 'Direct upload needs an S3 primary storage', grouping: true }],
    ])
    expect(modelOf(w)).toEqual([])

    // confirm 404: the key is gone (expired) — shown by the field, the request layer leaves 404s alone
    error.mockClear()
    backend({ 'POST /storage/objects/confirm': fail(404, 'A0404', 'Not found') })
    await pick(w, file('b.pdf', 'application/pdf'))
    expect(error.mock.calls).toEqual([['Not found']])
    expect(modelOf(w)).toEqual([])
  })

  it('off (the default): images and files go through the server as before', async () => {
    const calls = backend()
    const puts = storageHost()
    const img = withModel(ImageUpload, { bizTag: 'cover' })
    await pick(img, file('c.png', 'image/png'))
    const doc = withModel(FileUpload)
    await pick(doc, file('d.pdf', 'application/pdf'))
    const posts = () => calls.filter((c) => c.method === 'post').map((c) => c.url)
    expect(posts()).toEqual(['/storage/objects', '/storage/objects'])
    expect(puts).toHaveLength(0)

    // ImageUpload passes the switch on as well
    const direct = withModel(ImageUpload, { bizTag: 'cover', direct: true })
    await pick(direct, file('e.png', 'image/png'))
    expect(posts().slice(2)).toEqual(['/storage/objects/presign', '/storage/objects/confirm'])
    const presign = calls.find((c) => c.url === '/storage/objects/presign')
    expect((json(presign) as { bizTag: string }).bizTag).toBe('cover')
    expect(puts).toHaveLength(1)
  })
})
