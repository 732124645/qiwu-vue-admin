// OAuth2 clients: the built-in console row is read-only; an add and a reset show the secret once.
import type { Locator } from '@playwright/test'
import { expect, msg, signIn, test, type Page } from './fixtures.ts'

const ID = 'e2e-app-1'
const entity = msg('oauth.client.entity')
const field = (prop: string) => msg(`field.oauth.client.${prop}`)
const button = (scope: Page | Locator, key: string) =>
  scope.getByRole('button', { name: msg(key), exact: true })
const row = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text })

/** The secret dialog: reads the secret, then "I have saved it" closes it. */
async function takeSecret(page: Page) {
  const shown = page.getByRole('dialog', { name: msg('oauth.client.secretTitle') })
  await expect(shown.getByText(msg('oauth.client.secretOnce'))).toBeVisible()
  await expect(shown.getByRole('textbox', { name: field('clientId') })).toHaveValue(ID)
  const secret = await shown.getByRole('textbox', { name: field('secret') }).inputValue()
  expect(secret).toMatch(/^[\w-]{43}$/) // 32 random bytes, base64url
  // ESC does not close it: the secret would be gone
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400) // past the leave animation, had ESC closed it
  await expect(shown).toBeVisible()
  await button(shown, 'oauth.client.secretSaved').click()
  await expect(shown).toBeHidden()
  return secret
}

test('clients: console is locked; add shows the secret once → edit → reset secret → delete', async ({
  page,
}) => {
  await signIn(page, 'admin', '/oauth/clients')
  const builtin = row(page, msg('seed.oauth.console'))
  await expect(builtin).toContainText('console')
  await expect(builtin.getByRole('cell', { name: '是', exact: true })).toBeVisible()
  for (const key of ['crud.action.edit', 'menu.action.resetSecret', 'crud.action.delete'])
    await expect(button(builtin, key)).toBeDisabled()
  await expect(builtin.getByRole('switch')).toBeDisabled()
  await expect(builtin.getByRole('checkbox')).toBeDisabled()

  // add: the shared rules first (required, then the redirect URI rule on the field)
  await button(page, 'crud.action.create').click()
  const create = page.getByRole('dialog', {
    name: msg('crud.title.create', 'zh-CN', { name: entity }),
  })
  await expect(create.getByText(field('secret'))).toHaveCount(0)
  await button(create, 'crud.action.save').click()
  await expect(
    create.getByText(msg('validation.required', 'zh-CN', { field: field('name') })),
  ).toBeVisible()
  await create.getByRole('textbox', { name: field('clientId') }).fill(ID)
  await create.getByRole('textbox', { name: field('name') }).fill('E2E app')
  const uris = create.getByRole('textbox', { name: field('redirectUris') })
  await uris.fill('http://evil.com/cb')
  await uris.press('Enter')
  await uris.blur()
  const badUri = msg('validation.oauth.redirect_uri', 'zh-CN', { field: field('redirectUris') })
  await expect(create.getByText(badUri)).toBeVisible()
  await uris.press('Backspace') // drops the last tag
  await uris.fill('https://app.example.com/cb')
  await uris.press('Enter')
  await uris.blur()
  await expect(create.getByText(badUri)).toBeHidden()
  await button(create, 'crud.action.save').click()
  await expect(page.getByText(msg('crud.msg.created'))).toBeVisible()
  await expect(create).toBeHidden()
  const first = await takeSecret(page)
  await expect(row(page, ID)).toContainText('E2E app')
  await expect(row(page, ID)).toContainText(msg('oauth.client.grant.authorization_code'))

  // edit: no secret field, the client id is fixed
  await button(row(page, ID), 'crud.action.edit').click()
  const edit = page.getByRole('dialog', { name: msg('crud.title.edit', 'zh-CN', { name: entity }) })
  await expect(edit.getByRole('textbox', { name: field('clientId') })).toHaveValue(ID)
  await expect(edit.getByRole('textbox', { name: field('clientId') })).toBeDisabled()
  await expect(edit.getByText(field('secret'))).toHaveCount(0)
  await edit.getByRole('textbox', { name: field('name') }).fill('E2E app renamed')
  await button(edit, 'crud.action.save').click()
  await expect(edit).toBeHidden()
  await expect(row(page, ID)).toContainText('E2E app renamed')

  // reset: confirmed first, then a new secret, shown once
  await button(row(page, ID), 'menu.action.resetSecret').click()
  const confirm = page.getByRole('dialog', { name: msg('crud.confirm.title') })
  await expect(confirm).toContainText(msg('oauth.client.resetConfirm', 'zh-CN', { id: ID }))
  await button(confirm, 'menu.action.resetSecret').click()
  const second = await takeSecret(page)
  expect(second).not.toBe(first)

  await button(row(page, ID), 'crud.action.delete').click()
  await button(
    page.getByRole('dialog', { name: msg('crud.confirm.title') }),
    'crud.action.delete',
  ).click()
  await expect(page.getByText(msg('crud.msg.deleted'))).toBeVisible()
  await expect(row(page, ID)).toHaveCount(0)
})

test('clients: scope fields occupy separate rows without overlapping labels at 1280px', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1280, height: 1000 })
  await signIn(page, 'admin', '/oauth/clients')
  await button(page, 'crud.action.create').click()
  const dialog = page.getByRole('dialog', {
    name: msg('crud.title.create', 'zh-CN', { name: entity }),
  })
  const scopes = dialog.locator('.el-form-item').filter({
    has: page.getByText(field('scopes'), { exact: true }),
  })
  const auto = dialog.locator('.el-form-item').filter({
    has: page.getByText(field('autoApproveScopes'), { exact: true }),
  })
  await expect(scopes).toBeVisible()
  await expect(auto).toBeVisible()
  const scopeBox = await scopes.boundingBox()
  const autoBox = await auto.boundingBox()
  expect(autoBox!.y).toBeGreaterThanOrEqual(scopeBox!.y + scopeBox!.height)
  expect(autoBox!.x).toBe(scopeBox!.x)
  const labelBox = await auto.locator('.el-form-item__label').boundingBox()
  for (const checkbox of await scopes.getByRole('checkbox').all()) {
    const box = await checkbox.boundingBox()
    expect(box!.y + box!.height).toBeLessThanOrEqual(labelBox!.y)
  }
  await dialog.screenshot({ path: info.outputPath('oauth-client-scopes-1280.png') })
})
