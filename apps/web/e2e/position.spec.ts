import { expect, msg, signIn, test, type Page } from './fixtures.ts'

const CODE = 'e2e-position-1'
const entity = msg('iam.position.entity')
const field = (prop: string) => msg(`field.iam.position.${prop}`)
const button = (page: Page, key: string) =>
  page.getByRole('button', { name: msg(key), exact: true })
const row = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text })

async function searchCode(page: Page, code: string) {
  await page.getByRole('textbox', { name: field('code') }).fill(code)
  await button(page, 'crud.action.search').click()
}

async function removeRow(page: Page, text: string) {
  await row(page, text)
    .getByRole('button', { name: msg('crud.action.delete'), exact: true })
    .click()
  await page
    .getByRole('dialog', { name: msg('crud.confirm.title') })
    .getByRole('button', { name: msg('crud.action.delete'), exact: true })
    .click()
}

test('positions: add → search → edit → disable → delete', async ({ page }) => {
  await signIn(page, 'admin', '/iam/positions')
  await expect(row(page, msg('seed.position.engLead'))).toBeVisible()

  // add, with the shared zod rules checked first
  await button(page, 'crud.action.create').click()
  const create = page.getByRole('dialog', {
    name: msg('crud.title.create', 'zh-CN', { name: entity }),
  })
  await create.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(
    create.getByText(msg('validation.required', 'zh-CN', { field: field('code') })),
  ).toBeVisible()
  await create.getByRole('textbox', { name: field('code') }).fill(CODE)
  await create.getByRole('textbox', { name: field('name') }).fill('E2E position')
  await create.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(page.getByText(msg('crud.msg.created'))).toBeVisible()
  await expect(create).toBeHidden()

  // search narrows the list to it
  await searchCode(page, CODE)
  await expect(page.getByRole('row')).toHaveCount(2) // header + the row
  await expect(row(page, CODE)).toContainText('E2E position')

  // edit loads the stored row
  await row(page, CODE)
    .getByRole('button', { name: msg('crud.action.edit') })
    .click()
  const edit = page.getByRole('dialog', { name: msg('crud.title.edit', 'zh-CN', { name: entity }) })
  const name = edit.getByRole('textbox', { name: field('name') })
  await expect(name).toHaveValue('E2E position')
  await name.fill('E2E position renamed')
  await edit.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(edit).toBeHidden()
  await expect(row(page, CODE)).toContainText('E2E position renamed')

  // disable from the list
  const enabled = row(page, CODE).getByRole('switch')
  await expect(enabled).toBeChecked()
  await row(page, CODE).locator('.el-switch').click()
  await expect(enabled).not.toBeChecked()

  await removeRow(page, CODE)
  await expect(page.getByText(msg('crud.msg.deleted'))).toBeVisible()
  await expect(row(page, CODE)).toHaveCount(0)
})

test('deleting the position the admin holds → 409 in_use message, the row stays', async ({
  page,
}) => {
  await signIn(page, 'admin', '/iam/positions')
  await searchCode(page, 'eng_lead')
  const held = msg('seed.position.engLead')
  await removeRow(page, held)
  // the server's translated `error.common.in_use`, toasted by the request layer
  await expect(page.getByText('数据正在被使用，不能删除')).toBeVisible()
  await expect(row(page, held)).toBeVisible()
})

test('seeded names: found by the shown name in zh-CN and en-US; saving an unchanged name keeps the key', async ({
  page,
}) => {
  await signIn(page, 'admin', '/iam/positions')
  const searchName = async (text: string, lang = 'zh-CN') => {
    await page
      .getByRole('textbox', { name: msg('field.iam.position.name', lang), exact: true })
      .fill(text)
    await page.getByRole('button', { name: msg('crud.action.search', lang), exact: true }).click()
  }
  const zh = msg('seed.position.designer')
  await searchName(zh)
  await expect(page.getByRole('row')).toHaveCount(2) // header + the row
  await expect(row(page, zh)).toBeVisible()

  // the form shows the text, not the key; saving it unchanged sends the key back
  await row(page, zh)
    .getByRole('button', { name: msg('crud.action.edit') })
    .click()
  const edit = page.getByRole('dialog', { name: msg('crud.title.edit', 'zh-CN', { name: entity }) })
  await expect(edit.getByRole('textbox', { name: field('name') })).toHaveValue(zh)
  await edit.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(edit).toBeHidden()

  // still the key: in en-US the row follows the language and is found by its English name
  await page.evaluate(`localStorage.setItem('qw.locale', 'en-US')`)
  await page.reload()
  const en = msg('seed.position.designer', 'en-US')
  await searchName(en.split(' ').at(-1)!.toUpperCase(), 'en-US')
  await expect(page.getByRole('row')).toHaveCount(2)
  await expect(row(page, en)).toBeVisible()
})

test('export downloads the filtered positions as .xlsx named after the page', async ({ page }) => {
  await signIn(page, 'admin', '/iam/positions')
  await searchCode(page, 'eng_lead')
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    button(page, 'crud.action.export').click(),
  ])
  expect(file.suggestedFilename()).toBe(`${msg('menu.iam.position')}.xlsx`)
  const chunks: Buffer[] = []
  for await (const chunk of await file.createReadStream()) chunks.push(chunk as Buffer)
  // an .xlsx is a zip
  expect(Buffer.concat(chunks).subarray(0, 2).toString()).toBe('PK')
})
