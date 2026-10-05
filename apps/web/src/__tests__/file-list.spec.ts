// File list page (storage/object; see docs/design-notes.md#storage): list + filters, open / preview / copy link, upload,
// export, delete with the "may still be referenced" warning; perms; against a fake backend.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElImageViewer, ElMessage, ElMessageBox } from 'element-plus'
import type { FsObjectRowVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import FileList from '@/views/platform/storage/object/index.vue'
import { me, mockApi, ok, type Route } from './mock-api'

const row = (id: number, extra: Partial<FsObjectRowVo> = {}): FsObjectRowVo => ({
  id,
  originalName: `file${id}.pdf`,
  mime: 'application/pdf',
  size: 1536,
  url: null,
  isPublic: false,
  bizTag: 'attachment',
  createdAt: '2026-09-28T01:00:00.000Z',
  storageId: 1,
  storageName: 'seed.storage.local',
  uploaderId: 1,
  uploaderName: 'Admin',
  ...extra,
})
const PUBLIC_PNG = row(1, {
  originalName: 'logo.png',
  mime: 'image/png',
  url: '/files/public/2026/09/28/logo.png',
  isPublic: true,
  bizTag: 'cover',
})
const PRIVATE_PNG = row(2, { originalName: 'scan.png', mime: 'image/png' })
// uploaded by a user deleted since: the API keeps the id, the name is null (soft delete)
const PRIVATE_PDF = row(3, { uploaderId: 12, uploaderName: null })
const LIST = [PUBLIC_PNG, PRIVATE_PNG, PRIVATE_PDF]

function backend(extra: Record<string, Route> = {}) {
  return mockApi({
    'GET /storage/objects': ok({ items: LIST, total: 3 }),
    'GET /storage/objects/2/download': [200, new Blob(['png'])],
    'GET /storage/objects/3/download': [200, new Blob(['pdf'])],
    'GET /storage/objects/export': [200, new Blob(['xlsx'])],
    'DELETE /storage/objects/3': ok(null),
    'POST /storage/objects': ok(row(4)),
    'GET /settings/dicts/core.yes_no/entries': ok({
      version: 1,
      entries: ['true', 'false'].map((value, sortNo) => ({
        value,
        label: value === 'true' ? 'Yes' : 'No',
        labelI18n: null,
        tagType: value === 'true' ? 'success' : 'info',
        cssClass: null,
        isDefault: false,
        sortNo,
      })),
    }),
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
  page = mount(FileList, {
    global: { plugins: [ElementPlus, i18n, router], directives: { perm: vPerm } },
    attachTo: document.body,
  })
  await flushPromises()
}
const rows = () => page.findAll('.el-table__body .el-table__row')
const button = (text: string, root: VueWrapper | ReturnType<VueWrapper['find']> = page) =>
  root.findAll('button').find((b) => b.text() === text)
const visible = (b: ReturnType<VueWrapper['find']> | undefined) =>
  !!b && (b.element as HTMLElement).style.display !== 'none'

let confirm: ReturnType<typeof vi.spyOn>
let success: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>
beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
  success = vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
  error = vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview-1')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})
afterEach(() => {
  page.unmount()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('file list', () => {
  it('lists the files newest first and filters by name, tag, visibility and upload days', async () => {
    const calls = backend()
    await mountPage()
    expect(calls[0]?.params).toMatchObject({ page: 1, sort: '-createdAt' })
    const cells = (i: number) =>
      rows()
        [i]!.findAll('td')
        .map((td) => td.text())
    // name, type, size, tag, public, storage (seeded name as text), uploader, uploaded at
    expect(cells(0).slice(0, 7)).toEqual([
      'logo.png',
      'image/png',
      '1.5 kB',
      'Cover',
      'Yes',
      'Local storage',
      'Admin',
    ])
    expect(cells(2)[3]).toBe('Attachment')
    expect(cells(2)[6]).toBe('#12 (deleted)')
    // a public file is a link to its URL; a private one downloads with the token
    expect(rows()[0]!.find('a').attributes('href')).toBe(PUBLIC_PNG.url)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await button('file3.pdf', rows()[2])!.trigger('click')
    await flushPromises()
    expect(calls.at(-1)).toMatchObject({
      url: '/storage/objects/3/download',
      responseType: 'blob',
    })
    expect(calls.at(-1)?.headers.Authorization).toBe('Bearer at')
    expect(click).toHaveBeenCalledOnce()

    await page.find('input[name="originalName"]').setValue('rep')
    ;(page.vm as unknown as { query: Record<string, unknown> }).query.bizTag = 'cover'
    ;(page.vm as unknown as { query: Record<string, unknown> }).query.isPublic = 'true'
    ;(page.vm as unknown as { query: Record<string, unknown> }).query.createdAtRange = [
      '2026-09-01',
      '2026-09-28',
    ]
    await page.find('.qw-search-panel form').trigger('submit')
    await flushPromises()
    const params = calls.findLast((c) => c.url === '/storage/objects')?.params as Record<
      string,
      unknown
    >
    expect(params).toMatchObject({
      originalName: 'rep',
      bizTag: 'cover',
      isPublic: 'true',
      page: 1,
    })
    expect(params.createdAtFrom).toMatch(/^2026-0[89]-\d\dT/)
    expect(params.createdAtTo).toMatch(/^2026-09-2\dT/)
  })

  it('copies the full link of public files only', async () => {
    backend()
    await mountPage()
    expect(button('Copy link', rows()[1])).toBeUndefined()
    expect(button('Copy link', rows()[2])).toBeUndefined()
    await button('Copy link', rows()[0])!.trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(`${location.origin}${PUBLIC_PNG.url}`)
    expect(success).toHaveBeenLastCalledWith('Link copied')

    writeText.mockRejectedValueOnce(new Error('denied'))
    await button('Copy link', rows()[0])!.trigger('click')
    await flushPromises()
    expect(error).toHaveBeenLastCalledWith('The link could not be copied')
  })

  it('previews images only: a public one by its URL, a private one through fetchBlob, freed on close', async () => {
    const calls = backend()
    await mountPage()
    expect(button('Preview', rows()[2])).toBeUndefined()

    await button('Preview', rows()[0])!.trigger('click')
    await flushPromises()
    let viewer = page.findComponent(ElImageViewer)
    expect(viewer.props('urlList')).toEqual([PUBLIC_PNG.url])
    viewer.vm.$emit('close')
    await flushPromises()
    expect(page.findComponent(ElImageViewer).exists()).toBe(false)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()

    await button('Preview', rows()[1])!.trigger('click')
    await flushPromises()
    expect(calls.at(-1)).toMatchObject({
      url: '/storage/objects/2/download',
      responseType: 'blob',
    })
    viewer = page.findComponent(ElImageViewer)
    expect(viewer.props('urlList')).toEqual(['blob:preview-1'])
    viewer.vm.$emit('close')
    await flushPromises()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')
  })

  it('deletes after a confirmation that the file goes offline now, is purged later and may still be referenced', async () => {
    const calls = backend()
    await mountPage()
    confirm.mockRejectedValueOnce('cancel')
    await button('Delete', rows()[2])!.trigger('click')
    await flushPromises()
    expect(calls.some((c) => c.method === 'delete')).toBe(false)

    await button('Delete', rows()[2])!.trigger('click')
    await flushPromises()
    expect(confirm.mock.calls.at(-1)?.[0]).toBe(
      'Delete "file3.pdf"? It stops being served at once (its public link too); the stored file is purged after the retention period. Where a file is used is not recorded: pages, records or messages that still link or attach it will show a broken file.',
    )
    expect(calls.filter((c) => c.method === 'delete').map((c) => c.url)).toEqual([
      '/storage/objects/3',
    ])
    expect(success).toHaveBeenLastCalledWith('Deleted')
    // reloaded after the delete
    expect(calls.at(-1)?.url).toBe('/storage/objects')
  })

  it('uploads picked files as private attachments and reloads; exports the filtered list', async () => {
    const calls = backend()
    await mountPage()
    const input = page.find('input[type=file]')
    const f = new File(['%PDF'], 'new.pdf', { type: 'application/pdf' })
    Object.defineProperty(input.element, 'files', { value: [f], configurable: true })
    await input.trigger('change')
    await flushPromises()
    const upload = calls.find((c) => c.method === 'post' && c.url === '/storage/objects')!
    expect((upload.data as FormData).get('bizTag')).toBe('attachment')
    expect(success).toHaveBeenLastCalledWith('"new.pdf" uploaded')
    expect(calls.at(-1)?.url).toBe('/storage/objects')

    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await button('Export')!.trigger('click')
    await flushPromises()
    expect(calls.at(-1)).toMatchObject({ url: '/storage/objects/export', responseType: 'blob' })
    expect(calls.at(-1)?.params).toMatchObject({ sort: '-createdAt' })
    expect(calls.at(-1)?.params).not.toHaveProperty('page')
  })

  it('hides delete and export without their perms', async () => {
    backend()
    await mountPage(['storage.object.browse'])
    expect(visible(button('Delete', rows()[0]))).toBe(false)
    expect(visible(button('Export'))).toBe(false)
    expect(visible(button('Upload file'))).toBe(true)
  })
})
