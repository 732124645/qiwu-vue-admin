// Uploads (see docs/design-notes.md#storage): storageApi, FileUpload, ImageUpload (private previews through fetchBlob) and
// AvatarCropper (cropperjs 2 custom elements), against the fake backend.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive, type Component } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElImageViewer, ElMessage } from 'element-plus'
import type { CropperSelection } from 'cropperjs'
import type { FsObjectVo } from '@qiwu/shared'
import { storageApi } from '@/api/platform/storage/object'
import AvatarCropper from '@/core/components/AvatarCropper.vue'
import FileUpload from '@/core/components/FileUpload.vue'
import ImageUpload from '@/core/components/ImageUpload.vue'
import { formatSize, uploadField, uploadMaxSize, uploadName } from '@/core/composables/use-upload'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import { fail, mockApi, ok, type Route } from './mock-api'

const obj = (id: number, name: string, extra: Partial<FsObjectVo> = {}): FsObjectVo => ({
  id,
  originalName: name,
  mime: 'application/pdf',
  size: 2048,
  url: null,
  isPublic: false,
  bizTag: 'attachment',
  createdAt: '2026-09-27T00:00:00.000Z',
  ...extra,
})
const file = (name: string, type: string, size = 4) => new File(['x'.repeat(size)], name, { type })

/** The fake POST /storage/objects: answers each upload with an object named after the file, ids from 1. */
function storage(reply?: (form: FormData) => ReturnType<typeof ok> | undefined) {
  let id = 0
  const route: Route = (c) => {
    const form = c.data as FormData
    const f = form.get('file') as File
    return reply?.(form) ?? ok(obj(++id, f.name, { mime: f.type, size: f.size }))
  }
  return route
}

/** Picks files in the component's file input, as the browser's picker would. */
async function pick(w: VueWrapper, ...files: File[]) {
  const input = w.find('input[type=file]')
  Object.defineProperty(input.element, 'files', { value: files, configurable: true })
  await input.trigger('change')
  await flushPromises()
}

/** Mounts `component` with a working `v-model` (FsObjectVo[]). */
function withModel(
  component: typeof FileUpload | typeof ImageUpload,
  props = {},
  model: FsObjectVo[] = [],
) {
  const w: VueWrapper = mount(component as Component, {
    props: {
      modelValue: model,
      'onUpdate:modelValue': (v: unknown) => w.setProps({ modelValue: v }),
      ...props,
    },
    global: { plugins: [ElementPlus, i18n] },
    attachTo: document.body,
  })
  return w
}
const modelOf = (w: VueWrapper) => (w.props() as { modelValue: FsObjectVo[] }).modelValue

let error: ReturnType<typeof vi.spyOn>
let warning: ReturnType<typeof vi.spyOn>
let objectUrls: number
// the server's upload limit is read once per page: unreadable here (404), the default applies (the
// readable case is upload-limit.spec)
beforeAll(async () => {
  mockApi({})
  await uploadMaxSize()
})
beforeEach(() => {
  setLocale('en-US')
  accessToken.value = 'at'
  error = vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
  warning = vi.spyOn(ElMessage, 'warning').mockReturnValue(undefined as never)
  objectUrls = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:url-${++objectUrls}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('storageApi and formatSize', () => {
  it('uploads multipart with the tag before the file, and reads private bytes with the token', async () => {
    const calls = mockApi({
      'POST /storage/objects': storage(),
      'GET /storage/objects/5/download': [200, new Blob(['png'])],
    })
    const stored = await storageApi.upload(file('a.pdf', 'application/pdf'), 'attachment')
    expect(stored).toMatchObject({ id: 1, originalName: 'a.pdf' })
    const form = calls[0]?.data as FormData
    expect([...form.keys()]).toEqual(['bizTag', 'file'])
    expect(form.get('bizTag')).toBe('attachment')
    expect(calls[0]?.headers.Authorization).toBe('Bearer at')

    await expect(storageApi.blob(5)).resolves.toBeInstanceOf(Blob)
    expect(calls[1]).toMatchObject({ url: '/storage/objects/5/download', responseType: 'blob' })
  })

  it('formats sizes in the current locale', () => {
    expect([512, 1536, 20 * 1024 * 1024].map(formatSize)).toEqual(['512 byte', '1.5 kB', '20 MB'])
  })
})

describe('FileUpload', () => {
  it('uploads picked files under its tag and lists them; removing only drops them from the list', async () => {
    const calls = mockApi({ 'POST /storage/objects': storage() })
    const w = withModel(FileUpload, { bizTag: 'import' })
    await pick(w, file('a.pdf', 'application/pdf'), file('b.docx', 'application/msword'))

    expect(modelOf(w).map((o) => o.originalName)).toEqual(['a.pdf', 'b.docx'])
    expect(calls.map((c) => (c.data as FormData).get('bizTag'))).toEqual(['import', 'import'])
    expect(w.findAll('.file-upload__name').map((n) => n.text())).toEqual(['a.pdf', 'b.docx'])

    await w.find('[aria-label="Remove a.pdf"]').trigger('click')
    expect(modelOf(w).map((o) => o.originalName)).toEqual(['b.docx'])
    expect(calls).toHaveLength(2) // no delete request
  })

  it('shows the file while it uploads, then the stored object', async () => {
    let answer = (_reply: ReturnType<typeof ok>) => {}
    mockApi({ 'POST /storage/objects': () => new Promise((r) => (answer = r)) })
    const w = withModel(FileUpload)
    await pick(w, file('slow.pdf', 'application/pdf'))
    expect(w.find('[aria-busy="true"]').text()).toContain('slow.pdf')

    answer(ok(obj(9, 'slow.pdf')))
    await flushPromises()
    expect(w.find('[aria-busy="true"]').exists()).toBe(false)
    expect(modelOf(w).map((o) => o.id)).toEqual([9])
  })

  it('checks the count and size before sending and shows what the server rejects', async () => {
    const calls = mockApi({
      'POST /storage/objects': storage((form) =>
        (form.get('file') as File).name === 'big.zip'
          ? fail(413, 'A0413', 'Larger than the 20 MB limit')
          : undefined,
      ),
    })
    const w = withModel(FileUpload, { limit: 2, maxSize: 10 })
    await pick(w, file('huge.pdf', 'application/pdf', 11))
    expect(error).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: '"huge.pdf" is larger than 10 byte' }),
    )
    expect(calls).toHaveLength(0)

    // three at once for two places: the third is refused before sending
    await pick(
      w,
      file('a.pdf', 'application/pdf'),
      file('b.pdf', 'application/pdf'),
      file('c.pdf', 'application/pdf'),
    )
    expect(warning).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'You can upload up to 2', grouping: true }),
    )
    expect(calls).toHaveLength(2)
    expect(modelOf(w)).toHaveLength(2)
    // full: the picker is disabled
    expect(w.find('input[type=file]').attributes('disabled')).toBeDefined()
    expect(w.find('button').attributes('disabled')).toBeDefined()

    const v = withModel(FileUpload)
    await pick(v, file('big.zip', 'application/zip'))
    expect(error).toHaveBeenLastCalledWith('Larger than the 20 MB limit')
    expect(modelOf(v)).toEqual([])
  })

  it('the server’s limit unreadable: the 20 MB default, in the hint and checked before sending', async () => {
    const calls = mockApi({ 'POST /storage/objects': storage() })
    const w = withModel(FileUpload)
    expect(w.find('.file-upload__tip').text()).toContain('20 MB')
    const big = file('big.pdf', 'application/pdf')
    Object.defineProperty(big, 'size', { value: 20 * 1024 * 1024 + 1 })
    await pick(w, big)
    expect(error).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: '"big.pdf" is larger than 20 MB' }),
    )
    expect(calls).toHaveLength(0)
  })

  it('downloads a private file with the token and links a public one', async () => {
    const calls = mockApi({ 'GET /storage/objects/7/download': [200, new Blob(['pdf'])] })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const w = withModel(FileUpload, {}, [
      obj(7, 'secret.pdf'),
      obj(8, 'logo.png', { url: '/files/2026/09/27/x.png', isPublic: true }),
    ])

    await w.find('button.file-upload__name').trigger('click')
    await flushPromises()
    expect(calls[0]).toMatchObject({ url: '/storage/objects/7/download', responseType: 'blob' })
    expect(click).toHaveBeenCalledOnce()
    expect(w.find('a.file-upload__name').attributes('href')).toBe('/files/2026/09/27/x.png')
  })

  it('disabled: no upload button and no remove buttons', () => {
    const w = withModel(FileUpload, { disabled: true }, [obj(1, 'a.pdf')])
    expect(w.find('input[type=file]').exists()).toBe(false)
    expect(w.find('[aria-label="Remove a.pdf"]').exists()).toBe(false)
  })
})

describe('ImageUpload', () => {
  const png = (id: number, extra: Partial<FsObjectVo> = {}) =>
    obj(id, `p${id}.png`, { mime: 'image/png', ...extra })

  it('shows private images through fetchBlob object URLs, revoked when removed or unmounted', async () => {
    const calls = mockApi({
      'GET /storage/objects/2/download': [200, new Blob(['png'])],
      'GET /storage/objects/3/download': [200, new Blob(['png'])],
    })
    const w = withModel(ImageUpload, { limit: 3 }, [
      png(1, { url: '/files/a.png', isPublic: true }),
      png(2),
      png(3),
    ])
    await flushPromises()
    expect(w.findAll('img').map((i) => i.attributes('src'))).toEqual([
      '/files/a.png',
      'blob:url-1',
      'blob:url-2',
    ])
    expect(calls.map((c) => c.url)).toEqual([
      '/storage/objects/2/download',
      '/storage/objects/3/download',
    ])

    await w.find('[aria-label="Remove p2.png"]').trigger('click')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:url-1')
    w.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:url-2')
  })

  it('a failed preview shows a placeholder; an image removed while loading leaks no URL', async () => {
    let answer = (_reply: [number, unknown]) => {}
    mockApi({
      'GET /storage/objects/2/download': fail(403, 'A0301'),
      'GET /storage/objects/3/download': () => new Promise((r) => (answer = r)),
    })
    const w = withModel(ImageUpload, { limit: 2 }, [png(2), png(3)])
    await flushPromises()
    expect(w.findAll('img')).toHaveLength(0)
    expect(w.findAll('.image-upload__placeholder')).toHaveLength(2)

    await w.setProps({ modelValue: [png(2)] })
    answer([200, new Blob(['png'])])
    await flushPromises()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('takes images only, up to the limit; the add card goes when full', async () => {
    const calls = mockApi({ 'POST /storage/objects': storage() })
    const w = withModel(ImageUpload, { bizTag: 'cover' })
    expect(w.find('input[type=file]').attributes('accept')).toBe(
      'image/png,image/jpeg,image/gif,image/webp',
    )
    await pick(w, file('doc.pdf', 'application/pdf'))
    expect(error).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: '"doc.pdf" is not a PNG, JPG, GIF or WebP image' }),
    )
    expect(calls).toHaveLength(0)

    await pick(w, file('c.png', 'image/png'))
    expect((calls[0]!.data as FormData).get('bizTag')).toBe('cover')
    expect(modelOf(w).map((o) => o.originalName)).toEqual(['c.png'])
    expect(w.find('input[type=file]').exists()).toBe(false)
  })

  it('opens the viewer on the image whose preview button was pressed', async () => {
    mockApi({})
    const w = withModel(ImageUpload, { limit: 2 }, [
      png(1, { url: '/files/a.png' }),
      png(2, { url: '/files/b.png' }),
    ])
    await w.find('[aria-label="Preview p2.png"]').trigger('click')
    const viewer = w.findComponent(ElImageViewer)
    expect(viewer.props()).toMatchObject({
      urlList: ['/files/a.png', '/files/b.png'],
      initialIndex: 1,
    })
    viewer.vm.$emit('close')
    await flushPromises()
    expect(w.findComponent(ElImageViewer).exists()).toBe(false)
  })
})

describe('AvatarCropper', () => {
  // happy-dom decodes no images: every <img> "loads" as 640×480, as cropperjs' $ready expects; the
  // viewer's deferred redraws (setTimeout) are dropped after each test instead of running on a torn-down page
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true)
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(640)
    vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(480)
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })
  function cropper(upload: (f: File) => Promise<unknown>) {
    return mount(AvatarCropper as Component, {
      props: { upload },
      global: { plugins: [ElementPlus, i18n] },
      attachTo: document.body,
    }) as VueWrapper
  }
  const save = (w: VueWrapper) => w.findAll('.qw-dialog-footer button')[1]!

  it('renders cropperjs custom elements (not Vue components) once an image is picked', async () => {
    const warn = vi.spyOn(console, 'warn')
    const w = cropper(async () => null)
    expect(w.find('cropper-canvas').exists()).toBe(false)
    expect(save(w).attributes('disabled')).toBeDefined()

    await pick(w, file('notes.txt', 'text/plain'))
    expect(error).toHaveBeenLastCalledWith('"notes.txt" is not a PNG, JPG, GIF or WebP image')
    expect(w.find('cropper-canvas').exists()).toBe(false)

    await pick(w, file('me.jpg', 'image/jpeg'))
    const image = w.find('cropper-image').element as HTMLElement & { src: string }
    expect(image.src).toBe('blob:url-1')
    expect(customElements.get('cropper-selection')).toBeDefined()
    expect(w.find('cropper-selection').element).toBeInstanceOf(
      customElements.get('cropper-selection')!,
    )
    expect(warn.mock.calls.flat().join(' ')).not.toContain('Failed to resolve component')

    // another image replaces the first and frees its URL
    await pick(w, file('me2.png', 'image/png'))
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:url-1')
    expect((w.find('cropper-image').element as HTMLElement & { src: string }).src).toBe(
      'blob:url-2',
    )
    w.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:url-2')
  })

  it('an image the browser cannot decode is dropped with a message', async () => {
    const CropperImage = customElements.get('cropper-image')!
    vi.spyOn(
      CropperImage.prototype as { $ready: () => Promise<unknown> },
      '$ready',
    ).mockRejectedValueOnce(new Error('Failed to load the image source'))
    const w = cropper(async () => null)
    await pick(w, file('broken.jpg', 'image/jpeg'))
    expect(error).toHaveBeenLastCalledWith('This image could not be cropped. Try another one.')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:url-1')
    expect(w.find('cropper-canvas').exists()).toBe(false)
  })

  it('saves a 256×256 PNG crop through `upload` with a loading button, then emits its result', async () => {
    let finish = (_result: unknown) => {}
    const upload = vi.fn<(f: File) => Promise<unknown>>(() => new Promise((r) => (finish = r)))
    const w = cropper(upload)
    await pick(w, file('me.jpg', 'image/jpeg'))
    const selection = w.find('cropper-selection').element as CropperSelection
    const toCanvas = vi.fn<CropperSelection['$toCanvas']>(
      async () =>
        ({
          toBlob: (cb: BlobCallback, type?: string) => cb(new Blob(['png'], { type })),
        }) as HTMLCanvasElement,
    )
    selection.$toCanvas = toCanvas

    await save(w).trigger('click')
    await flushPromises()
    expect(toCanvas).toHaveBeenCalledWith({ width: 256, height: 256 })
    expect(upload.mock.calls[0]?.[0]).toMatchObject({ name: 'avatar.png', type: 'image/png' })
    expect(save(w).classes()).toContain('is-loading')

    finish({ avatarUrl: '/files/avatar.webp' })
    await flushPromises()
    expect(w.emitted('done')).toEqual([[{ avatarUrl: '/files/avatar.webp' }]])
  })

  it('a failed upload keeps the dialog open and shows what the request layer does not', async () => {
    const { ApiError } = await import('@/core/request/http')
    const w = cropper(() => Promise.reject(new ApiError(413, 'A0413', 'Too large')))
    await pick(w, file('me.jpg', 'image/jpeg'))
    ;(w.find('cropper-selection').element as CropperSelection).$toCanvas = (async () => ({
      toBlob: (cb: BlobCallback) => cb(new Blob(['png'])),
    })) as never
    await save(w).trigger('click')
    await flushPromises()
    expect(error).toHaveBeenLastCalledWith('Too large')
    expect(w.emitted('done')).toBeUndefined()
    expect(save(w).classes()).not.toContain('is-loading')

    // no crop at all (e.g. the canvas is tainted): a message, no upload
    ;(w.find('cropper-selection').element as CropperSelection).$toCanvas = (async () => ({
      toBlob: (cb: BlobCallback) => cb(null),
    })) as never
    await save(w).trigger('click')
    await flushPromises()
    expect(error).toHaveBeenLastCalledWith('This image could not be cropped. Try another one.')
  })

  it('keeps the frame on the stage and the stage covered by the image', async () => {
    const w = cropper(async () => null)
    await pick(w, file('me.jpg', 'image/jpeg'))
    const stage = w.find('cropper-canvas').element
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({ width: 320, height: 320 } as DOMRect)
    const change = (el: Element, detail: object) => {
      const e = new CustomEvent('change', { detail, cancelable: true })
      el.dispatchEvent(e)
      return e.defaultPrevented ? 'blocked' : 'ok'
    }
    const frame = w.find('cropper-selection').element
    expect(change(frame, { x: 10, y: 10, width: 300, height: 300 })).toBe('ok')
    expect(change(frame, { x: -1, y: 10, width: 200, height: 200 })).toBe('blocked')
    expect(change(frame, { x: 200, y: 200, width: 121, height: 121 })).toBe('blocked')

    const image = w.find('cropper-image').element
    expect(change(image, { x: -40, y: 0, width: 427, height: 320 })).toBe('ok')
    expect(change(image, { x: 8, y: 0, width: 427, height: 320 })).toBe('blocked')
    expect(change(image, { x: 0, y: 0, width: 300, height: 300 })).toBe('blocked')
  })
})

describe('uploadField', () => {
  it('keeps one upload in a text column: an image by its public URL, a file as <id>/<name>', async () => {
    const model = reactive<Record<string, unknown>>({
      cover: '/files/cover/b.png',
      doc: '42/report 1.pdf',
      none: '',
    })
    const cover = uploadField(model, 'cover', 'image')
    const doc = uploadField(model, 'doc', 'file')
    expect(cover.value).toMatchObject([
      { id: 0, originalName: 'b.png', url: '/files/cover/b.png', isPublic: true },
    ])
    expect(doc.value).toMatchObject([{ id: 42, originalName: 'report 1.pdf', url: null }])
    expect(uploadField(model, 'none', 'file').value).toEqual([])
    expect(uploadName(model.doc as string)).toBe('report 1.pdf')
    expect(uploadName(null)).toBe('')

    // a kept file has no size to show; it still downloads by id
    const w = withModel(FileUpload, {}, doc.value)
    expect(w.find('.file-upload__name').text()).toBe('report 1.pdf')
    expect(w.find('.file-upload__size').exists()).toBe(false)

    doc.value = [obj(7, 'x.pdf')]
    expect(model.doc).toBe('7/x.pdf')
    cover.value = [obj(8, 'c.png', { url: '/files/c.png', isPublic: true })]
    expect(model.cover).toBe('/files/c.png')
    doc.value = []
    expect(model.doc).toBe('')
  })
})
