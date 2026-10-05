import { createRequire } from 'node:module'
import type { Locator } from '@playwright/test'
import { currentPage, expect, msg, signIn, test, type Page } from './fixtures.ts'

// The generated demo_book page (G0): reached through 系统工具 / 生成示例 in the side menu, then
// add (with a department: the module is data-scoped) → search → edit → detail drawer → export
// (download) → delete.

const ISBN = 'e2e-book-1'
const entity = msg('demo.book.entity')
const field = (prop: string) => msg(`field.demo.book.${prop}`)
const button = (page: Page, key: string) =>
  page.getByRole('button', { name: msg(key), exact: true })
const row = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text })

/** exceljs from the server's dependencies reads the export (no web dependency for a test) */
const ExcelJS = createRequire(new URL('../../server/package.json', import.meta.url))('exceljs') as {
  Workbook: new () => {
    xlsx: { load(b: Buffer): Promise<unknown> }
    worksheets: { eachRow(cb: (row: { values: unknown[] }) => void): void }[]
  }
}

async function rowsOf(file: { createReadStream(): Promise<NodeJS.ReadableStream> }) {
  const chunks: Buffer[] = []
  for await (const chunk of await file.createReadStream()) chunks.push(chunk as Buffer)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(Buffer.concat(chunks))
  const rows: unknown[][] = []
  wb.worksheets[0]!.eachRow((r) => rows.push(r.values))
  return rows
}

/** Picks the dict entry `label` of the el-select labelled `label` inside `scope`. */
async function pick(page: Page, scope: Locator, name: string, label: string) {
  await scope.getByRole('combobox', { name }).click({ force: true })
  await page.getByRole('option', { name: label, exact: true }).click()
}

test('books: menu → add → search → edit → detail → export → delete', async ({ page }) => {
  await signIn(page, 'admin', '/home')
  const menu = page.getByRole('navigation', { name: msg('common.layout.sideMenu') })
  await expect(menu.getByText(msg('menu.devtools.title'))).toBeVisible()
  await menu.getByText(msg('menu.devtools.title')).click()
  await menu.getByText(msg('menu.demo.title')).click()
  await menu.getByRole('menuitem', { name: msg('menu.demo.book') }).click()
  await expect(page).toHaveURL(/\/demo\/books$/)
  await expect(currentPage(page, 'menu.demo.book')).toBeVisible()

  // add, with the shared zod rules checked first
  await button(page, 'crud.action.create').click()
  const create = page.getByRole('dialog', {
    name: msg('crud.title.create', 'zh-CN', { name: entity }),
  })
  await create.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(
    create.getByText(msg('validation.required', 'zh-CN', { field: field('isbn') })),
  ).toBeVisible()
  await create.getByRole('textbox', { name: field('isbn') }).fill(ISBN)
  await create.getByRole('textbox', { name: field('title') }).fill('E2E book')
  await create.getByRole('textbox', { name: field('author') }).fill('E2E author')
  await create.getByRole('spinbutton', { name: field('price') }).fill('42.5')
  await pick(page, create, field('genre'), '历史') // demo.genre `history` (a dict label, from the DB)
  // the genre dropdown closed first (an open one takes the next click as "outside")
  await expect(page.getByRole('option', { name: '历史', exact: true })).toBeHidden()
  await create.getByRole('combobox', { name: field('deptId') }).click({ force: true })
  // the search panel's dept filter has a dropdown too: the open one
  await page
    .locator('.el-select-dropdown')
    .filter({ visible: true })
    .getByText(msg('seed.dept.rd'), { exact: true })
    .click()
  await create.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(page.getByText(msg('crud.msg.created'))).toBeVisible()
  await expect(create).toBeHidden()

  // search narrows the list to it; another genre finds nothing
  const search = page.locator('.qw-search-panel')
  await search.getByRole('textbox', { name: field('isbn') }).fill(ISBN)
  await pick(page, search, field('genre'), '小说')
  await button(page, 'crud.action.search').click()
  await expect(page.getByText(msg('common.empty.noMatch'), { exact: true })).toBeVisible()
  await pick(page, search, field('genre'), '历史')
  await button(page, 'crud.action.search').click()
  await expect(page.getByRole('row')).toHaveCount(2) // header + the row
  await expect(row(page, ISBN)).toContainText('E2E book')
  await expect(row(page, ISBN)).toContainText('42.50')

  // edit loads the stored row
  await row(page, ISBN)
    .getByRole('button', { name: msg('crud.action.edit') })
    .click()
  const edit = page.getByRole('dialog', { name: msg('crud.title.edit', 'zh-CN', { name: entity }) })
  const title = edit.getByRole('textbox', { name: field('title') })
  await expect(title).toHaveValue('E2E book')
  await title.fill('E2E book renamed')
  await edit.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(edit).toBeHidden()
  await expect(row(page, ISBN)).toContainText('E2E book renamed')

  // the detail drawer opens from the title
  await row(page, ISBN).getByRole('button', { name: 'E2E book renamed' }).click()
  const drawer = page.getByRole('dialog', {
    name: msg('crud.title.detail', 'zh-CN', { name: entity }),
  })
  await expect(drawer).toContainText('E2E author')
  await expect(drawer).toContainText(msg('seed.dept.rd'))
  await drawer.getByRole('button', { name: /close|关闭/i }).click()
  await expect(drawer).toBeHidden()

  // export: the filtered rows, the genre as its label
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    button(page, 'crud.action.export').click(),
  ])
  expect(file.suggestedFilename()).toBe(`${msg('menu.demo.book')}.xlsx`)
  const [header, ...data] = await rowsOf(file)
  expect(header).toContain(field('isbn'))
  expect(data).toHaveLength(1)
  expect(data[0]).toEqual(expect.arrayContaining([ISBN, 'E2E book renamed', '历史']))

  // delete
  await row(page, ISBN)
    .getByRole('button', { name: msg('crud.action.delete'), exact: true })
    .click()
  await page
    .getByRole('dialog', { name: msg('crud.confirm.title') })
    .getByRole('button', { name: msg('crud.action.delete'), exact: true })
    .click()
  await expect(page.getByText(msg('crud.msg.deleted'))).toBeVisible()
  await expect(row(page, ISBN)).toHaveCount(0)
})
