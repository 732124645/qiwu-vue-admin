// Generator page 1 (see docs/design-notes.md#codegen): the imported configs, the import dialog, sync, delete one / many,
// the edit link, perms; against the fake backend of codegen-api.schema.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElDropdown, ElMessage, ElMessageBox } from 'element-plus'
import type { CgTableVo } from '@qiwu/shared'
import { dialogs } from '@/core/dialog'
import DialogHost from '@/core/dialog/DialogHost.vue'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import CodegenList from '@/views/platform/codegen/index.vue'
import { me, mockApi, ok, type Route } from './mock-api'

const cfg = (id: number, tableName: string, extra: Partial<CgTableVo> = {}): CgTableVo => ({
  id,
  tableName,
  tableComment: `${tableName} comment`,
  groupCode: 'biz',
  domain: 'demo',
  business: tableName.replace(/^demo_/, ''),
  className: 'Book',
  featureName: 'Books',
  featureNameI18n: { 'zh-CN': 'zh books', 'en-US': 'Books EN' },
  template: 'crud',
  createdAt: '2026-09-27T01:00:00.000Z',
  updatedAt: '2026-09-27T02:00:00.000Z',
  ...extra,
})
const LIST = [cfg(1, 'demo_book'), cfg(2, 'demo_topic', { template: 'tree' })]

function backend(extra: Record<string, Route> = {}) {
  return mockApi({
    'GET /codegen/tables': ok({ items: LIST, total: 2 }),
    'GET /codegen/tables/importable': ok([
      { tableName: 'demo_invoice', tableComment: 'Invoices', noDeletedAt: false },
      { tableName: 'demo_invoice_line', tableComment: 'Invoice lines', noDeletedAt: false },
      { tableName: 'shop_log', tableComment: 'Logs', noDeletedAt: true },
      { tableName: 'shop_order', tableComment: 'Orders', noDeletedAt: false },
    ]),
    'POST /codegen/tables/import': ok({
      ids: [3, 4],
      hints: [
        { tableName: 'shop_order', missing: 'alive', key: 'uk_shop_order_no' },
        { tableName: 'shop_order', missing: 'parent_menu', key: 'shop' },
      ],
    }),
    'POST /codegen/tables/1/sync': ok({
      added: ['isbn'],
      removed: [],
      changed: ['title', 'price'],
    }),
    'DELETE /codegen/tables/1': ok(null),
    'POST /codegen/tables/batch-delete': ok(null),
    ...extra,
  })
}
const sent = (calls: { method?: string; url?: string }[]) =>
  calls
    .map((c) => `${c.method?.toUpperCase()} ${c.url}`)
    .filter((u) => u.startsWith('POST') || u.startsWith('DELETE') || u.endsWith('/tables'))

let host: VueWrapper
let page: VueWrapper
let router: Router
async function mountPage(perms = ['*']) {
  useAuthStore().me = me(perms)
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { render: () => null } },
      { path: '/codegen/tables/:id', component: { render: () => null } },
    ],
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
const cells = (col: number) =>
  page.findAll('.el-table__body .el-table__row').map((r) => r.findAll('td')[col]?.text())
const button = (text: string) => page.findAll('button').find((b) => b.text() === text)
/** the rows' "more" menus (el-table also renders each column once without a row, off the body) */
const mores = () =>
  page
    .findAllComponents(ElDropdown)
    .filter((d) => d.classes('codegen-more') && d.element.closest('.el-table__body'))

let confirm: ReturnType<typeof vi.spyOn>
let success: ReturnType<typeof vi.spyOn>
let warning: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
  success = vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
  warning = vi.spyOn(ElMessage, 'warning').mockReturnValue(undefined as never)
})
afterEach(() => {
  page.unmount()
  host.unmount()
  dialogs.splice(0)
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('codegen list', () => {
  it('lists the configs newest first with their filters, template names and localized feature names', async () => {
    const calls = backend()
    await mountPage()
    expect(calls[0]?.params).toMatchObject({ page: 1, sort: '-updatedAt' })
    // selection, tableName, featureName, className, template, …
    expect(cells(1)).toEqual(['demo_book', 'demo_topic'])
    expect(cells(2)).toEqual(['Books EN', 'Books EN'])
    expect(cells(4)).toEqual(['Single table', 'Tree'])

    await page.find('input[name="tableName"]').setValue('book')
    await page.find('.qw-search-panel form').trigger('submit')
    await flushPromises()
    expect(calls.at(-1)?.params).toMatchObject({ tableName: 'book', page: 1 })
  })

  it('imports the tables ticked in the dialog, the filter keeping the ticks, then reloads; a table without deleted_at cannot be ticked', async () => {
    const calls = backend()
    await mountPage()
    await button('Import tables')!.trigger('click')
    await flushPromises()
    const dialog = body().find('.el-dialog')
    expect(dialog.find('.el-dialog__title').text()).toBe('Import tables')
    const rows = () => dialog.findAll('.el-table__body .el-table__row')
    expect(rows().map((r) => r.findAll('td')[1]?.text())).toEqual([
      'demo_invoice',
      'demo_invoice_line',
      'shop_log',
      'shop_order',
    ])
    // no deleted_at: not tickable, the reason beside its comment
    const box = (row: number) => rows()[row]!.find('.el-checkbox input')
    expect(box(2).attributes('disabled')).toBeDefined()
    expect(box(3).attributes('disabled')).toBeUndefined()
    expect(rows()[2]!.findAll('td')[2]?.text()).toBe(
      'No deleted_at column: add deleted_at datetime(3) NULL to import it (the generated code soft-deletes) Logs',
    )
    expect(rows()[3]!.findAll('td')[2]?.text()).toBe('Orders')
    const submit = () => dialog.findAll('.qw-dialog-footer button')[1]!
    expect(submit().attributes('disabled')).toBeDefined()

    await box(3).setValue(true)
    await dialog.find('input[name="keyword"]').setValue('INVOICE')
    await flushPromises()
    expect(rows()).toHaveLength(2)
    await rows()[0]!.find('.el-checkbox input').setValue(true)
    await submit().trigger('click')
    await flushPromises()

    expect(calls.find((c) => c.url === '/codegen/tables/import')?.data).toBe(
      JSON.stringify({ tableNames: ['shop_order', 'demo_invoice'] }),
    )
    expect(success).toHaveBeenCalledWith('2 table(s) imported')
    // a unique key without alive, no menu group of its own: one warning each,
    // imported anyway
    expect(warning.mock.calls.map((c: unknown[]) => (c[0] as { message: string }).message)).toEqual(
      [
        'The unique key uk_shop_order_no of shop_order lacks the alive column, so values in deleted rows cannot be reused. Change the unique key to (…, alive).',
        'Table shop_order: no menu group shop (or subgroup) is available for this page, so its parent defaults to Business (biz). Create a group in Menus, then select it on the Generation tab.',
      ],
    )
    await vi.waitFor(() => expect(dialogs).toHaveLength(0))
    expect(sent(calls).slice(-2)).toEqual(['POST /codegen/tables/import', 'GET /codegen/tables'])
  })

  it('syncs a table after asking, with what changed; deletes one or the selected ones', async () => {
    const calls = backend()
    await mountPage()
    const more = mores()[0]!
    more.vm.$emit('command', 'sync')
    await flushPromises()
    expect(confirm.mock.calls[0]?.[0]).toBe(
      'Read the columns of demo_book from the database again? Config you changed by hand is kept.',
    )
    expect(success).toHaveBeenCalledWith('Synced: 1 column(s) added, 0 removed, 2 changed')
    expect(sent(calls).slice(-2)).toEqual(['POST /codegen/tables/1/sync', 'GET /codegen/tables'])

    more.vm.$emit('command', 'remove')
    await flushPromises()
    expect(sent(calls).slice(-2)).toEqual(['DELETE /codegen/tables/1', 'GET /codegen/tables'])

    for (const row of page.findAll('.el-table__body .el-table__row'))
      await row.find('.el-checkbox input').setValue(true)
    await button('Delete selected')!.trigger('click')
    await flushPromises()
    expect(calls.find((c) => c.url === '/codegen/tables/batch-delete')?.data).toBe(
      JSON.stringify({ ids: [1, 2] }),
    )

    // a refused confirm sends nothing
    confirm.mockRejectedValueOnce('cancel')
    const before = calls.length
    more.vm.$emit('command', 'sync')
    await flushPromises()
    expect(calls).toHaveLength(before)
  })

  it('edit opens the hidden edit page of the row', async () => {
    backend()
    await mountPage()
    await page.findAll('.el-table__body .el-table__row')[1]!.find('button').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/codegen/tables/2')
  })

  it('shows only what the perms allow', async () => {
    backend()
    await mountPage(['codegen.table.browse', 'codegen.table.view'])
    expect(button('Import tables')?.isVisible()).toBe(false)
    expect(button('Edit')).toBeUndefined()
    expect(mores()).toHaveLength(0)
  })
})
