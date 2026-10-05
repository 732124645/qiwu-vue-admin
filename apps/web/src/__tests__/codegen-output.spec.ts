// Generator page 3 (see docs/design-notes.md#codegen): preview in CodeViewer, download one or many as a zip, write into the
// workspace (only where the server allows it) with the diffs shown on refusal; against the fake backend.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElDropdown, ElMessage, ElMessageBox } from 'element-plus'
import type { CgTableVo, CgWriteResultVo } from '@qiwu/shared'
import { dialogs } from '@/core/dialog'
import DialogHost from '@/core/dialog/DialogHost.vue'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import CodegenList from '@/views/platform/codegen/index.vue'
import { fail, me, mockApi, ok, type Route } from './mock-api'

const cfg = (id: number, tableName: string): CgTableVo => ({
  id,
  tableName,
  tableComment: '',
  groupCode: 'biz',
  domain: 'demo',
  business: tableName.replace(/^demo_/, ''),
  className: 'X',
  featureName: tableName,
  featureNameI18n: null,
  template: 'crud',
  createdAt: '2026-09-27T01:00:00.000Z',
  updatedAt: '2026-09-27T02:00:00.000Z',
})
const PREVIEW = {
  files: [
    {
      path: 'apps/server/src/modules/demo/book/book.entity.ts',
      language: 'typescript',
      content: 'export class Book {}\n',
    },
    {
      path: 'apps/web/src/views/demo/book/index.vue',
      language: 'vue',
      content: '<template><div /></template>\n',
    },
  ],
  registration: ['imports: [BookModule] in modules/project.module.ts', 'SEEDS.demo: seedBook'],
}
const written: CgWriteResultVo = {
  written: ['apps/server/src/modules/demo/book/book.entity.ts'],
  unchanged: [],
  conflicts: [],
  registration: ['imports: [BookModule]'],
}
const refused: CgWriteResultVo = {
  written: [],
  unchanged: [],
  conflicts: [
    {
      path: 'apps/web/src/views/demo/book/index.vue',
      diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old line\n+new line',
    },
  ],
  registration: [],
}

function backend(writable: boolean, extra: Record<string, Route> = {}) {
  return mockApi({
    'GET /codegen/tables': ok({ items: [cfg(1, 'demo_book'), cfg(2, 'demo_topic')], total: 2 }),
    'GET /codegen/tables/writable': ok({ writable }),
    'GET /codegen/tables/1/preview': ok(PREVIEW),
    'GET /codegen/tables/download': [200, new Blob(['PK'])],
    'POST /codegen/tables/write': ok(written),
    ...extra,
  })
}

let host: VueWrapper
let page: VueWrapper
async function mountPage(perms = ['*']) {
  useAuthStore().me = me(perms)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  await router.push('/')
  const global = {
    plugins: [ElementPlus, i18n, router],
    directives: { perm: vPerm },
    stubs: { transition: false },
  }
  host = mount(DialogHost, { global, attachTo: document.body })
  page = mount(CodegenList, { global, attachTo: document.body })
  await flushPromises()
}
const body = () => new DOMWrapper(document.body)
const rowButton = (row: number, text: string) =>
  page
    .findAll('.el-table__body .el-table__row')
    [row]!.findAll('button')
    .find((b) => b.text() === text)
const toolbarButton = (text: string) =>
  page.findAll('.table-toolbar button').find((b) => b.text() === text)
const mores = () =>
  page
    .findAllComponents(ElDropdown)
    .filter((d) => d.classes('codegen-more') && d.element.closest('.el-table__body'))
const menuItems = () =>
  body()
    .findAll('.el-dropdown-menu__item')
    .map((i) => i.text())
async function selectAll() {
  for (const row of page.findAll('.el-table__body .el-table__row'))
    await row.find('.el-checkbox input').setValue(true)
}

let saved: { href: string; name: string }[]
beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
  vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:zip')
  saved = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push({ href: this.href, name: this.download })
  })
})
afterEach(() => {
  page.unmount()
  host.unmount()
  dialogs.splice(0)
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('codegen output', () => {
  it('previews a config in CodeViewer with its registration lines, and downloads it from there', async () => {
    const calls = backend(true)
    await mountPage()
    await rowButton(0, 'Preview')!.trigger('click')
    await flushPromises()

    const dialog = body().find('.el-dialog')
    expect(dialog.find('.el-dialog__title').text()).toBe('Preview: demo_book')
    expect(dialog.find('.codegen-preview__count').text()).toBe('2 file(s)')
    expect(dialog.find('.code-viewer__path').text()).toBe(PREVIEW.files[0]!.path)
    expect(dialog.findAll('.el-tree-node__content').map((n) => n.text())).toContain('index.vue')
    expect(dialog.find('.codegen-preview__registration pre').text()).toBe(
      PREVIEW.registration.join('\n'),
    )

    const footer = () => dialog.findAll('.qw-dialog-footer button').map((b) => b.text())
    expect(footer()).toEqual(['Close', 'Download code', 'Write to workspace'])
    await dialog.findAll('.qw-dialog-footer button')[1]!.trigger('click')
    await flushPromises()
    const download = calls.find((c) => c.url === '/codegen/tables/download')
    expect(download).toMatchObject({ params: { ids: '1' }, responseType: 'blob', timeout: 300_000 })
    expect(saved).toEqual([{ href: 'blob:zip', name: 'demo_book.zip' }])
  })

  it('downloads the selected configs as one zip, and one from the row menu', async () => {
    const calls = backend(false)
    await mountPage()
    await selectAll()
    await toolbarButton('Download selected')!.trigger('click')
    await flushPromises()
    expect(calls.find((c) => c.url === '/codegen/tables/download')?.params).toEqual({ ids: '1,2' })
    expect(saved.at(-1)?.name).toBe('codegen.zip')

    mores()[1]!.vm.$emit('command', 'download')
    await flushPromises()
    expect(calls.filter((c) => c.url === '/codegen/tables/download').at(-1)?.params).toEqual({
      ids: '2',
    })
    expect(saved.at(-1)?.name).toBe('demo_topic.zip')
  })

  it('writes after asking and lists what was written with the registration lines', async () => {
    const calls = backend(true)
    await mountPage()
    await selectAll()
    await toolbarButton('Write selected')!.trigger('click')
    await flushPromises()
    expect(calls.find((c) => c.url === '/codegen/tables/write')?.data).toBe(
      JSON.stringify({ ids: [1, 2] }),
    )
    const dialog = body().find('.el-dialog')
    expect(dialog.find('.el-dialog__title').text()).toBe('Write result')
    expect(dialog.find('.el-alert__title').text()).toBe('1 file(s) written, 0 unchanged')
    expect(dialog.findAll('.codegen-write__list pre').map((p) => p.text())).toEqual([
      written.written[0],
      written.registration[0],
    ])
  })

  it('a refused write shows every difference as a diff and says nothing was written', async () => {
    backend(true, { 'POST /codegen/tables/write': ok(refused) })
    await mountPage()
    mores()[0]!.vm.$emit('command', 'write')
    await flushPromises()
    const dialog = body().find('.el-dialog')
    expect(dialog.find('.el-alert--error .el-alert__title').text()).toBe(
      '1 existing file(s) differ from the generated ones, so nothing was written. Resolve these differences first:',
    )
    expect(dialog.find('.code-viewer__path').text()).toBe(refused.conflicts[0]!.path)
    expect(dialog.findAll('.code-viewer__line').map((l) => l.text())).toEqual([
      '--- a',
      '+++ b',
      '@@ -1 +1 @@',
      '-old line',
      '+new line',
    ])
  })

  it('offers writing only where the server allows it and to holders of the write perm', async () => {
    backend(false)
    await mountPage()
    await selectAll()
    expect(toolbarButton('Write selected')).toBeUndefined()
    await rowButton(0, 'Preview')!.trigger('click')
    await flushPromises()
    expect(
      body()
        .findAll('.qw-dialog-footer button')
        .map((b) => b.text()),
    ).toEqual(['Close', 'Download code'])
    page.unmount()
    host.unmount()
    dialogs.splice(0)

    backend(true)
    await mountPage(['codegen.table.browse', 'codegen.table.generate'])
    await selectAll()
    expect(toolbarButton('Download selected')).toBeDefined()
    expect(toolbarButton('Write selected')).toBeUndefined()
    await mores()[0]!.find('button').trigger('click')
    await flushPromises()
    // every row's menu (they render up front) holds the download only
    expect([...new Set(menuItems())]).toEqual(['Download code'])
  })

  it('a config the templates refuse closes the preview (the request layer shows why)', async () => {
    backend(true, { 'GET /codegen/tables/1/preview': fail(422, 'C3003', 'No label column') })
    await mountPage()
    await rowButton(0, 'Preview')!.trigger('click')
    await flushPromises()
    await vi.waitFor(() => expect(dialogs).toHaveLength(0))
  })
})
