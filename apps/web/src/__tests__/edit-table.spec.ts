// QwEditTable in a master-sub form (docs/codegen-golden.md "Master-sub"), through the generated
// demo_invoice form against the fake backend: rows are added and deleted in place, every cell is checked
// by the row schema on save, the document is posted once with all its rows.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElMessage } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import InvoiceForm from '@/views/demo/invoice/form.vue'
import { mockApi, ok } from './mock-api'

beforeEach(() => {
  setLocale('zh-CN')
  setActivePinia(createPinia())
  accessToken.value = 'at'
  vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
})
afterEach(() => vi.restoreAllMocks())

const DICT = 'GET /settings/dicts/demo.invoice_state/entries'
const mountForm = (id?: number) =>
  mount(InvoiceForm, { props: { id }, global: { plugins: [ElementPlus, i18n] } })
const rows = (w: ReturnType<typeof mountForm>) =>
  w.findAll('.qw-edit-table .el-table__body tr.el-table__row')
const button = (w: ReturnType<typeof mountForm>, text: string) =>
  w.findAll('button').find((b) => b.text() === text)!

it('add: rows added in place, an empty cell refused, then one POST with every row', async () => {
  const calls = mockApi({
    [DICT]: ok({ code: 'demo.invoice_state', version: 1, entries: [] }),
    'POST /demo/invoices': ok({ id: 9 }),
  })
  const w = mountForm()
  await w.find('input[maxlength="32"]').setValue('INV-1')
  await w.find('input[maxlength="128"]').setValue('buyer')
  await button(w, '添加一行').trigger('click')
  await button(w, '添加一行').trigger('click')
  expect(rows(w)).toHaveLength(2)
  await rows(w)[0]!.find('input').setValue('item a')

  await button(w, '保存').trigger('click')
  await vi.waitFor(() =>
    expect(w.findAll('.el-form-item__error').map((e) => e.text())).toEqual(['品名不能为空']),
  )
  expect(calls.filter((c) => c.method === 'post')).toHaveLength(0)

  await rows(w)[1]!.find('input').setValue('item b')
  await button(w, '保存').trigger('click')
  await vi.waitFor(() => expect(w.emitted('done')).toHaveLength(1))
  const post = calls.find((c) => c.method === 'post')!
  expect(JSON.parse(post.data as string)).toMatchObject({
    invoiceNo: 'INV-1',
    lines: [
      { item: 'item a', qty: 1, unitPrice: 0 },
      { item: 'item b', qty: 1, unitPrice: 0 },
    ],
  })
})

it('edit: loaded rows keep their ids; a deleted row is left out of the PUT', async () => {
  const line = (id: number, item: string) => ({ id, invoiceId: 3, item, qty: 2, unitPrice: 1.5 })
  const calls = mockApi({
    [DICT]: ok({ code: 'demo.invoice_state', version: 1, entries: [] }),
    'GET /demo/invoices/3': ok({
      id: 3,
      invoiceNo: 'INV-3',
      buyer: 'b',
      total: 3,
      issuedAt: null,
      state: 'draft',
      lines: [line(11, 'a'), line(12, 'b')],
    }),
    'PUT /demo/invoices/3': ok(null),
  })
  const w = mountForm(3)
  await flushPromises()
  expect(rows(w)).toHaveLength(2)
  await rows(w)[0]!
    .findAll('button')
    .find((b) => b.text() === '删除')!
    .trigger('click')
  expect(rows(w)).toHaveLength(1)
  await button(w, '保存').trigger('click')
  await vi.waitFor(() => expect(w.emitted('done')).toHaveLength(1))
  const put = calls.find((c) => c.method === 'put')!
  expect(JSON.parse(put.data as string).lines).toEqual([line(12, 'b')])
})
