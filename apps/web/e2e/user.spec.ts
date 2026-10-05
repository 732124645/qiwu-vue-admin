import { createRequire } from 'node:module'
import { currentPage, bearer, expect, msg, signIn, test, type Page } from './fixtures.ts'

// The user page (acceptance): add → search → edit → disable (the user's other session gets 401) → export
// (formula cell escaped) → delete (its position can be deleted then); import 3 rows with 1 error → error
// report; reset password; assign roles on the hidden sub-page.

const entity = msg('iam.user.entity')
const field = (prop: string) => msg(`field.iam.user.${prop}`)
const button = (page: Page, key: string) =>
  page.getByRole('button', { name: msg(key), exact: true })
const row = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text })
const PASSWORD = 'E2e-User@2026'

/** exceljs from the server's dependencies reads and writes the .xlsx files (no web dependency for a test) */
interface Sheet {
  eachRow(cb: (row: { values: unknown[] }) => void): void
  addRows(rows: unknown[][]): void
}
const ExcelJS = createRequire(new URL('../../server/package.json', import.meta.url))('exceljs') as {
  Workbook: new () => {
    xlsx: { load(b: Buffer): Promise<unknown>; writeBuffer(): Promise<ArrayBuffer> }
    worksheets: Sheet[]
    addWorksheet(name: string): Sheet
  }
}

async function bytesOf(file: { createReadStream(): Promise<NodeJS.ReadableStream> }) {
  const chunks: Buffer[] = []
  for await (const chunk of await file.createReadStream()) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

async function rowsOf(file: { createReadStream(): Promise<NodeJS.ReadableStream> }) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(await bytesOf(file))
  const rows: unknown[][] = []
  wb.worksheets[0]!.eachRow((r) => rows.push(r.values))
  return rows
}

async function xlsx(rows: unknown[][]) {
  const wb = new ExcelJS.Workbook()
  wb.addWorksheet('users').addRows(rows)
  return Buffer.from(await wb.xlsx.writeBuffer())
}

async function rowMenu(page: Page, username: string, key: string) {
  await row(page, username)
    .getByRole('button', { name: msg('crud.action.more') })
    .click()
  await page.getByRole('menuitem', { name: msg(key) }).click()
}

async function searchKeyword(page: Page, keyword: string) {
  await page.getByRole('textbox', { name: field('keyword') }).fill(keyword)
  await button(page, 'crud.action.search').click()
}

test('crud: add → search → edit → disable ends its sessions → export escapes formulas → delete frees the position', async ({
  page,
  request,
  browser,
}) => {
  const USERNAME = 'e2e-user-crud'
  // a position only this user holds: deletable again once the user is gone
  const admin = await bearer(request)
  const created = await request.post('/api/iam/positions', {
    headers: { Authorization: admin },
    data: { code: 'e2e-user-pos', name: 'E2E user position' },
  })
  expect(created.ok(), await created.text()).toBe(true)
  const positionId = ((await created.json()) as { data: { id: number } }).data.id

  await signIn(page, 'admin', '/iam/users')
  await expect(row(page, 'admin')).toBeVisible()

  // add, with the shared zod rules checked first
  await button(page, 'crud.action.create').click()
  const create = page.getByRole('dialog', {
    name: msg('crud.title.create', 'zh-CN', { name: entity }),
  })
  await create.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(
    create.getByText(msg('validation.required', 'zh-CN', { field: field('username') })),
  ).toBeVisible()
  await create.getByRole('textbox', { name: field('username') }).fill(USERNAME)
  // a display name starting with '=' must reach the export as text, never as a formula
  await create.getByRole('textbox', { name: field('displayName') }).fill('=1+2')
  await create.getByLabel(field('password'), { exact: true }).fill(PASSWORD)
  await create.getByRole('combobox', { name: field('deptId') }).click({ force: true })
  await page
    .locator('.el-select-dropdown')
    .getByText(msg('seed.dept.platform'), { exact: true })
    .click()
  await create.getByRole('combobox', { name: field('positionIds') }).click({ force: true })
  await page.getByRole('option', { name: 'E2E user position' }).click()
  await create.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(page.getByText(msg('crud.msg.created'))).toBeVisible()
  await expect(create).toBeHidden()

  // search narrows the list to it; the dept tree filters with the subtree
  await searchKeyword(page, USERNAME)
  await expect(page.getByRole('row')).toHaveCount(2) // header + the row
  await expect(row(page, USERNAME)).toContainText(msg('seed.dept.platform'))
  const tree = page.getByRole('tree', { name: msg('picker.dept.title') })
  await tree.getByText(msg('seed.dept.rd'), { exact: true }).click()
  await expect(row(page, USERNAME)).toBeVisible()
  await tree.getByText(msg('seed.dept.finance'), { exact: true }).click()
  await expect(page.getByText(msg('common.empty.noMatch'), { exact: true })).toBeVisible()
  await tree.getByText(msg('seed.dept.finance'), { exact: true }).click() // again: no dept filter
  await expect(row(page, USERNAME)).toBeVisible()
  // a typed created-at range covers whole local days
  const createdAt = async (from: string, to: string) => {
    await page.getByPlaceholder(msg('field.common.createdAtFrom')).fill(from)
    await page.getByPlaceholder(msg('field.common.createdAtTo')).fill(to)
    await page.getByPlaceholder(msg('field.common.createdAtTo')).press('Enter')
    await button(page, 'crud.action.search').click()
  }
  const today = new Date().toLocaleDateString('sv') // YYYY-MM-DD here
  await createdAt(today, today)
  await expect(row(page, USERNAME)).toBeVisible()
  await createdAt('2020-01-01', '2020-01-02')
  await expect(page.getByText(msg('common.empty.noMatch'), { exact: true })).toBeVisible()
  await button(page, 'crud.action.reset').click()
  await searchKeyword(page, USERNAME)
  await expect(row(page, USERNAME)).toBeVisible()

  // edit loads the stored row
  await row(page, USERNAME)
    .getByRole('button', { name: msg('crud.action.edit') })
    .click()
  const edit = page.getByRole('dialog', { name: msg('crud.title.edit', 'zh-CN', { name: entity }) })
  await expect(edit.getByRole('textbox', { name: field('displayName') })).toHaveValue('=1+2')
  await expect(edit.getByLabel(field('password'), { exact: true })).toHaveCount(0)
  await edit.getByRole('textbox', { name: field('mobile') }).fill('13800000123')
  await edit.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(edit).toBeHidden()
  await expect(row(page, USERNAME)).toContainText('13800000123')

  // the detail drawer shows the dept and the position by name
  await row(page, USERNAME).getByRole('button', { name: USERNAME }).click()
  const drawer = page.getByRole('dialog', { name: msg('iam.user.detail') })
  await expect(drawer).toContainText(msg('seed.dept.platform'))
  await expect(drawer).toContainText('E2E user position')
  await drawer.getByRole('button', { name: /close|关闭/i }).click()
  await expect(drawer).toBeHidden()

  // disabling ends the user's sessions: another context signed in as them gets 401 on its next request
  const other = await browser.newContext()
  try {
    const session = await bearer(other.request, { username: USERNAME, password: PASSWORD })
    const me = () => other.request.get('/api/auth/me', { headers: { Authorization: session } })
    expect((await me()).status()).toBe(200)
    const enabled = row(page, USERNAME).getByRole('switch')
    await expect(enabled).toBeChecked()
    await row(page, USERNAME).locator('.el-switch').click()
    await expect(enabled).not.toBeChecked()
    expect((await me()).status()).toBe(401)
  } finally {
    await other.close()
  }

  // export: the filtered rows, the '=' cell escaped with a leading apostrophe
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    button(page, 'crud.action.export').click(),
  ])
  expect(file.suggestedFilename()).toBe(`${msg('menu.iam.user')}.xlsx`)
  const [header, ...data] = await rowsOf(file)
  expect(header).toContain(field('displayName'))
  expect(data).toHaveLength(1)
  expect(data[0]).toContain(USERNAME)
  expect(data[0]).toContain("'=1+2")

  // delete; the position it held is free again
  await row(page, USERNAME)
    .getByRole('button', { name: msg('crud.action.delete'), exact: true })
    .click()
  await page
    .getByRole('dialog', { name: msg('crud.confirm.title') })
    .getByRole('button', { name: msg('crud.action.delete'), exact: true })
    .click()
  await expect(page.getByText(msg('crud.msg.deleted'))).toBeVisible()
  await expect(row(page, USERNAME)).toHaveCount(0)
  const freed = await request.delete(`/api/iam/positions/${positionId}`, {
    headers: { Authorization: admin },
  })
  expect(freed.ok(), await freed.text()).toBe(true)
})

test('actions: import 3 rows with 1 error → error report, reset password, assign roles', async ({
  page,
  request,
}) => {
  await signIn(page, 'admin', '/iam/users')
  await expect(row(page, 'admin')).toBeVisible()

  // import: the template first, then a file whose third row has a bad email
  await button(page, 'crud.action.import').click()
  const dialog = page.getByRole('dialog', {
    name: msg('crud.title.import', 'zh-CN', { name: entity }),
  })
  const [template] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: msg('crud.import.template') }).click(),
  ])
  const name = msg('menu.iam.user')
  expect(template.suggestedFilename()).toBe(
    `${msg('crud.import.templateName', 'zh-CN', { name })}.xlsx`,
  )
  expect((await rowsOf(template))[0]).toContain(field('username'))
  await dialog.locator('input[type=file]').setInputFiles({
    name: 'users.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: await xlsx([
      ['username', 'displayName', 'email'],
      ['e2e-user-imp1', 'E2E import 1', 'imp1@example.test'],
      ['e2e-user-imp2', 'E2E import 2', 'imp2@example.test'],
      ['e2e-user-imp3', 'E2E import 3', 'not-an-email'],
    ]),
  })
  await dialog.getByRole('button', { name: msg('crud.import.submit') }).click()
  await expect(
    dialog.getByText(msg('crud.import.partial', 'zh-CN', { inserted: 2, updated: 0, failed: 1 })),
  ).toBeVisible()
  const [report] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: msg('crud.import.report') }).click(),
  ])
  expect(report.suggestedFilename()).toBe(
    `${msg('crud.import.reportName', 'zh-CN', { name })}.xlsx`,
  )
  const [, ...failed] = await rowsOf(report)
  expect(failed).toHaveLength(1)
  expect(failed[0]).toContain('e2e-user-imp3')
  await dialog.getByRole('button', { name: msg('crud.import.close'), exact: true }).click()
  await expect(dialog).toBeHidden()
  // the list reloaded with the imported rows
  await searchKeyword(page, 'e2e-user-imp')
  await expect(page.getByRole('row')).toHaveCount(3) // header + 2

  // reset password: the typed password signs in afterwards
  await rowMenu(page, 'e2e-user-imp1', 'menu.action.resetPassword')
  const reset = page.getByRole('dialog', {
    name: msg('iam.user.resetPassword.title', 'zh-CN', { name: 'e2e-user-imp1' }),
  })
  await reset.getByLabel(msg('common.passwordChange.newPassword'), { exact: true }).fill(PASSWORD)
  await reset
    .getByLabel(msg('common.passwordChange.confirmPassword'), { exact: true })
    .fill(PASSWORD)
  await reset.getByRole('button', { name: msg('menu.action.resetPassword') }).click()
  await expect(page.getByText(msg('iam.user.resetPassword.done'))).toBeVisible()
  await expect(reset).toBeHidden()
  await bearer(request, { username: 'e2e-user-imp1', password: PASSWORD })

  // assign roles on the hidden sub-page, back to the list after saving
  await rowMenu(page, 'e2e-user-imp1', 'menu.action.assignRoles')
  await expect(page).toHaveURL(/\/iam\/users\/\d+\/roles$/)
  await expect(currentPage(page, 'menu.iam.userRoles')).toBeVisible()
  const demo = page.getByRole('row').filter({ hasText: msg('seed.role.demo') })
  await demo.locator('.el-checkbox').click()
  await expect(demo.getByRole('checkbox')).toBeChecked()
  await button(page, 'crud.action.save').click()
  await expect(page.getByText(msg('iam.user.assignRoles.done'))).toBeVisible()
  await expect(page).toHaveURL(/\/iam\/users$/)
  await row(page, 'e2e-user-imp1').getByRole('button', { name: 'e2e-user-imp1' }).click()
  await expect(page.getByRole('dialog', { name: msg('iam.user.detail') })).toContainText(
    msg('seed.role.demo'),
  )
})
