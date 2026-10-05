import type { Download, Locator } from '@playwright/test'
import { currentPage, bearer, expect, msg, signIn, test, type Page } from './fixtures.ts'

// The generator pages (acceptance, import demo_book → change a field → preview ≥ 11
// files → batch zip not empty), one test per page task (`-g import` / `-g edit` / `-g output`). Each
// test stands alone: demo_book's config exists whether the seed or the import test stored it.

const BOOK = 'demo_book'
/** The table row (list or import dialog) of `table`, by its exact name. */
const row = (page: Page, table: string, scope: Page | Locator = page) =>
  scope.getByRole('row').filter({ has: page.getByText(table, { exact: true }) })
const button = (page: Page, key: string) =>
  page.getByRole('button', { name: msg(key), exact: true })
const confirmBox = (page: Page) => page.getByRole('dialog', { name: msg('crud.confirm.title') })

/** The row's "more" menu, then its item `key`. */
async function more(page: Page, table: string, key: string) {
  await row(page, table)
    .getByRole('button', { name: msg('crud.action.more') })
    .click()
  await page.getByRole('menuitem', { name: msg(key) }).click()
}

/** The download's bytes and the number of entries its zip directory lists. */
async function zipOf(download: Download) {
  const chunks: Buffer[] = []
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer)
  const zip = Buffer.concat(chunks)
  // end of central directory record: signature 0x06054b50, total entries at +10
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  return { size: zip.length, entries: end < 0 ? 0 : zip.readUInt16LE(end + 10) }
}

async function configId(request: Parameters<typeof bearer>[0], table: string) {
  const headers = { Authorization: await bearer(request) }
  const res = await request.get('/api/codegen/tables', { headers, params: { tableName: table } })
  expect(res.ok(), await res.text()).toBe(true)
  const { items } = ((await res.json()) as { data: { items: { id: number; tableName: string }[] } })
    .data
  return { headers, id: items.find((r) => r.tableName === table)!.id }
}

test('import: configs deleted one and several, the dialog lists the tables left, import and sync', async ({
  page,
}) => {
  await signIn(page, 'admin', '/home')
  const menu = page.getByRole('navigation', { name: msg('common.layout.sideMenu') })
  await menu.getByText(msg('menu.devtools.title')).click()
  await menu.getByRole('menuitem', { name: msg('menu.codegen.table') }).click()
  await expect(page).toHaveURL(/\/codegen\/tables$/)
  await expect(currentPage(page, 'menu.codegen.table')).toBeVisible()

  // one config through its row menu, two through the selection
  await expect(row(page, BOOK)).toBeVisible()
  await more(page, BOOK, 'crud.action.delete')
  await confirmBox(page)
    .getByRole('button', { name: msg('crud.action.delete') })
    .click()
  await expect(page.getByText(msg('crud.msg.deleted'))).toBeVisible()
  await expect(row(page, BOOK)).toHaveCount(0)
  for (const table of ['demo_topic', 'iam_position'])
    await row(page, table).locator('.el-checkbox').click()
  await button(page, 'crud.action.batchDelete').click()
  await confirmBox(page)
    .getByRole('button', { name: msg('crud.action.delete') })
    .click()
  await expect(row(page, 'demo_topic')).toHaveCount(0)
  await expect(row(page, 'iam_position')).toHaveCount(0)

  // the dialog: tables not imported yet, no framework tables; filtered, three ticked, imported
  await button(page, 'codegen.table.action.import').click()
  const dialog = page.getByRole('dialog', { name: msg('codegen.table.import.title') })
  await expect(row(page, BOOK, dialog)).toBeVisible()
  for (const absent of ['cg_table', 'cg_column', 'meta_migrations', 'demo_invoice'])
    await expect(dialog.getByText(absent, { exact: true })).toHaveCount(0)
  await expect(dialog.getByText('iam_user', { exact: true })).toBeVisible()
  await dialog.getByPlaceholder(msg('codegen.table.import.filter')).fill('demo_')
  await expect(dialog.getByText('iam_user', { exact: true })).toHaveCount(0)
  await row(page, BOOK, dialog).locator('.el-checkbox').click()
  await row(page, 'demo_topic', dialog).locator('.el-checkbox').click()
  // ticks survive the filter
  await dialog.getByPlaceholder(msg('codegen.table.import.filter')).fill('iam_position')
  await row(page, 'iam_position', dialog).locator('.el-checkbox').click()
  await dialog.getByRole('button', { name: msg('codegen.table.import.submit') }).click()
  await expect(
    page.getByText(msg('codegen.table.import.done', 'zh-CN', { count: 3 })),
  ).toBeVisible()
  await expect(dialog).toBeHidden()
  for (const table of [BOOK, 'demo_topic', 'iam_position'])
    await expect(row(page, table)).toBeVisible()

  // sync with the DDL: nothing changed
  await more(page, BOOK, 'codegen.table.action.sync')
  await confirmBox(page)
    .getByRole('button', { name: msg('codegen.table.action.sync') })
    .click()
  await expect(
    page.getByText(msg('codegen.table.sync.done', 'zh-CN', { added: 0, removed: 0, changed: 0 })),
  ).toBeVisible()
})

test('edit: a column and the generation settings saved, dict and parent-menu pickers filled', async ({
  page,
  request,
}) => {
  const { headers, id } = await configId(request, BOOK)
  await signIn(page, 'admin', '/codegen/tables')
  await row(page, BOOK)
    .getByRole('button', { name: msg('crud.action.edit'), exact: true })
    .click()
  await expect(page).toHaveURL(new RegExp(`/codegen/tables/${id}$`))
  await expect(page.locator('.qw-page-bar__context').getByText(BOOK, { exact: true })).toBeVisible()

  // basic info
  await page.getByRole('textbox', { name: msg('field.codegen.className') }).fill('DemoBook')

  // a column: its English label, a dict from dicts/options
  await page.getByRole('tab', { name: msg('codegen.table.edit.columns') }).click()
  const english = `${msg('field.codegen.labelI18n')} ${msg('common.language.enUS')}`
  await page.getByRole('textbox', { name: `${english} title` }).fill('E2E book title')
  await page
    .getByRole('combobox', { name: `${msg('field.codegen.dictCode')} genre` })
    .click({ force: true })
  await page.getByRole('option', { name: /\(demo\.genre\)$/ }).click()

  // generation: two form columns, the detail drawer, the parent menu picker
  await page.getByRole('tab', { name: msg('codegen.table.edit.generate') }).click()
  await page.locator('.el-radio-button').filter({ hasText: /^2$/ }).click()
  await page
    .getByRole('combobox', { name: msg('field.codegen.parentMenuRouteName') })
    .click({ force: true })
  await page.getByRole('treeitem', { name: msg('menu.demo.title'), exact: true }).click()
  await page.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(page.getByText(msg('crud.msg.updated'))).toBeVisible()

  // stored, and shown again after a reload
  const res = await request.get(`/api/codegen/tables/${id}`, { headers })
  const stored = (
    (await res.json()) as {
      data: {
        className: string
        formCols: number
        parentMenuRouteName: string
        columns: { columnName: string; dictCode: string | null; labelI18n: object }[]
      }
    }
  ).data
  expect(stored).toMatchObject({ className: 'DemoBook', formCols: 2, parentMenuRouteName: 'demo' })
  const column = (name: string) => stored.columns.find((c) => c.columnName === name)!
  expect(column('title').labelI18n).toMatchObject({ 'en-US': 'E2E book title' })
  expect(column('genre').dictCode).toBe('demo.genre')
  await page.reload()
  await page.getByRole('tab', { name: msg('codegen.table.edit.columns') }).click()
  await expect(page.getByRole('textbox', { name: `${english} title` })).toHaveValue(
    'E2E book title',
  )
})

test('output: preview of ≥ 11 files, one zip and a batch zip, no write outside development', async ({
  page,
  request,
}) => {
  const { headers, id } = await configId(request, BOOK)
  await signIn(page, 'admin', '/codegen/tables')
  // writing is off on this server: no write buttons anywhere
  await expect(page.getByText(msg('codegen.table.action.write'))).toHaveCount(0)

  await row(page, BOOK)
    .getByRole('button', { name: msg('codegen.table.action.preview'), exact: true })
    .click()
  const dialog = page.getByRole('dialog', {
    name: msg('codegen.table.preview.title', 'zh-CN', { table: BOOK }),
  })
  const count = dialog.getByText(
    new RegExp(`^${msg('codegen.table.preview.files', 'zh-CN', { count: '(\\d+)' })}$`),
  )
  await expect(count).toBeVisible()
  expect(Number(/\d+/.exec((await count.textContent())!)![0])).toBeGreaterThanOrEqual(11)
  // the file tree picks the shown file
  await dialog.getByText('book.service.ts', { exact: true }).click()
  await expect(dialog.locator('.code-viewer__path')).toHaveText(/book\.service\.ts$/)
  await expect(dialog.locator('.code-viewer__code')).toContainText('BaseCrudService')
  await expect(dialog.getByRole('button', { name: msg('codegen.table.action.write') })).toHaveCount(
    0,
  )

  // one config's zip
  const one = page.waitForEvent('download')
  await dialog.getByRole('button', { name: msg('codegen.table.action.download') }).click()
  const single = await one
  expect(single.suggestedFilename()).toBe(`${BOOK}.zip`)
  const files = await zipOf(single)
  expect(files.entries).toBeGreaterThanOrEqual(11)
  await dialog.getByRole('button', { name: msg('codegen.table.close'), exact: true }).click()
  await expect(dialog).toBeHidden()

  // the selected configs as one zip
  for (const table of [BOOK, 'demo_topic']) await row(page, table).locator('.el-checkbox').click()
  const batch = page.waitForEvent('download')
  await button(page, 'codegen.table.action.batchDownload').click()
  const both = await batch
  expect(both.suggestedFilename()).toBe('codegen.zip')
  const zip = await zipOf(both)
  expect(zip.size).toBeGreaterThan(files.size)
  expect(zip.entries).toBeGreaterThan(files.entries)

  // and the server refuses a write outside development
  const write = await request.post('/api/codegen/tables/write', { headers, data: { ids: [id] } })
  expect(write.status()).toBe(422)
  expect(((await write.json()) as { code: string }).code).toBe('C3005')
})
