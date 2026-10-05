import { currentPage, bearer, expect, msg, signIn, test, type Page } from './fixtures.ts'

// The generated demo_invoice page (the master_sub template's G0 sample, acceptance "主子表保存 2 条子项后
// 编辑删除 1 条"): reached through 系统工具 / 生成示例, then add an invoice with two lines (a line's rule is
// checked in its own cell) → edit it, delete the first line → the stored invoice keeps the second one
// only (same id: updated, not re-added) → delete the invoice.

const NO = 'e2e-demo-invoice-1'
const [ITEM_A, ITEM_B] = ['e2e-demo-item-a', 'e2e-demo-item-b']
const entity = msg('demo.invoice.entity')
const field = (prop: string) => msg(`field.demo.invoice.${prop}`)
const button = (page: Page, key: string) =>
  page.getByRole('button', { name: msg(key), exact: true })
const row = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text })
const dialog = (page: Page, key: 'create' | 'edit') =>
  page.getByRole('dialog', { name: msg(`crud.title.${key}`, 'zh-CN', { name: entity }) })
type Dialog = ReturnType<typeof dialog>
/** The lines of the dialog's editable table, in order. */
const lines = (d: Dialog) => d.locator('.qw-edit-table .el-table__body tr.el-table__row')

interface Invoice {
  id: number
  invoiceNo: string
  lines: { id: number; item: string; qty: number }[]
}
/** The stored invoice NO with its lines, through the API. */
async function stored(request: Parameters<typeof bearer>[0]): Promise<Invoice> {
  const headers = { Authorization: await bearer(request) }
  const page = await request.get('/api/demo/invoices', { headers, params: { invoiceNo: NO } })
  expect(page.ok(), await page.text()).toBe(true)
  const [{ id }] = ((await page.json()) as { data: { items: { id: number }[] } }).data.items
  const res = await request.get(`/api/demo/invoices/${id}`, { headers })
  return ((await res.json()) as { data: Invoice }).data
}

test('invoices: add with two lines → edit, delete one → one line left → delete', async ({
  page,
  request,
}) => {
  await signIn(page, 'admin', '/home')
  const menu = page.getByRole('navigation', { name: msg('common.layout.sideMenu') })
  await menu.getByText(msg('menu.devtools.title')).click()
  await menu.getByText(msg('menu.demo.title')).click()
  await menu.getByRole('menuitem', { name: msg('menu.demo.invoice') }).click()
  await expect(page).toHaveURL(/\/demo\/invoices$/)
  await expect(currentPage(page, 'menu.demo.invoice')).toBeVisible()

  // add: the invoice's fields, then two lines; an empty item is refused in its cell
  await button(page, 'crud.action.create').click()
  const create = dialog(page, 'create')
  await create.getByRole('textbox', { name: field('invoiceNo') }).fill(NO)
  await create.getByRole('textbox', { name: field('buyer') }).fill('e2e-demo buyer')
  await expect(create.getByText(msg('crud.editTable.empty'))).toBeVisible()
  const addRow = create.getByRole('button', { name: msg('crud.action.addRow') })
  await addRow.click()
  await addRow.click()
  await expect(lines(create)).toHaveCount(2)
  await lines(create).nth(0).getByRole('textbox').fill(ITEM_A)
  await create.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(
    lines(create)
      .nth(1)
      .getByText(msg('validation.required', 'zh-CN', { field: field('item') })),
  ).toBeVisible()
  await lines(create).nth(1).getByRole('textbox').fill(ITEM_B)
  await create.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(page.getByText(msg('crud.msg.created'))).toBeVisible()
  await expect(create).toBeHidden()
  await expect(row(page, NO)).toBeVisible()
  const added = await stored(request)
  expect(added.lines.map((l) => [l.item, l.qty])).toEqual([
    [ITEM_A, 1],
    [ITEM_B, 1],
  ])

  // edit: both lines loaded; delete the first, save
  await row(page, NO)
    .getByRole('button', { name: msg('crud.action.edit') })
    .click()
  const edit = dialog(page, 'edit')
  await expect(lines(edit)).toHaveCount(2)
  await expect(lines(edit).nth(0).getByRole('textbox')).toHaveValue(ITEM_A)
  await lines(edit)
    .nth(0)
    .getByRole('button', { name: msg('crud.action.delete'), exact: true })
    .click()
  await expect(lines(edit)).toHaveCount(1)
  await expect(lines(edit).nth(0).getByRole('textbox')).toHaveValue(ITEM_B)
  await edit.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(edit).toBeHidden()
  // the second line kept its id (updated in place), the first is gone
  expect((await stored(request)).lines).toEqual([
    expect.objectContaining({ id: added.lines[1]!.id, item: ITEM_B }),
  ])

  // delete the invoice (with its line)
  await row(page, NO)
    .getByRole('button', { name: msg('crud.action.delete'), exact: true })
    .click()
  await page
    .getByRole('dialog', { name: msg('crud.confirm.title') })
    .getByRole('button', { name: msg('crud.action.delete'), exact: true })
    .click()
  await expect(page.getByText(msg('crud.msg.deleted'))).toBeVisible()
  await expect(row(page, NO)).toHaveCount(0)
})
