import { bearer, expect, msg, signIn, test } from './fixtures.ts'
import { ok, pickAccount, wxoaAccount } from './wxoa.ts'

// Official account menus: a new default menu in the phone preview, a button name over WeChat's 16 bytes
// (6 CJK characters, 18 bytes) is refused before anything is sent, the fixed one is saved as a draft,
// then published (WeChat's side of publishing is stubbed: the page's behaviour only).

const field = (prop: string) => msg(`field.wxoa.menu.${prop}`)

test('menu editor: add a button → over 16 bytes refused → save → publish', async ({
  page,
  request,
}) => {
  const account = await wxoaAccount(request, 'e2e-wxoa-menu')
  const saves: string[] = []
  page.on('request', (r) => {
    if (r.method() !== 'GET' && /\/api\/wxoa\/menus(\/\d+)?$/.test(new URL(r.url()).pathname))
      saves.push(r.method())
  })

  await signIn(page, 'admin', '/wxoa/menus')
  await pickAccount(page, account.label)
  await expect(page.getByText(msg('wxoa.menu.empty'))).toBeVisible()
  await page.getByRole('button', { name: msg('wxoa.menu.newDefault') }).click()
  await page.getByRole('button', { name: msg('wxoa.menu.addButton') }).click()

  const editor = page.locator('.menu-editor')
  const name = editor.getByRole('textbox', { name: field('name') })
  await name.fill('一二三四五六')
  await editor.getByRole('textbox', { name: field('key') }).fill('E2E_MENU_KEY')
  await expect(
    editor.getByText(msg('wxoa.menu.bytes', 'zh-CN', { used: 18, max: 16 })),
  ).toHaveClass(/is-over/)
  await editor.getByRole('button', { name: msg('crud.action.save'), exact: true }).click()
  await expect(page.getByText(msg('wxoa.menu.fixErrors'))).toBeVisible()
  await expect(
    editor.getByText(msg('validation.wxoa.bytes', 'zh-CN', { field: field('name'), maxBytes: 16 })),
  ).toBeVisible()
  expect(saves).toEqual([])

  // 5 characters = 15 bytes: saved as a draft
  await name.fill('一二三四五')
  await expect(
    editor.getByText(msg('wxoa.menu.bytes', 'zh-CN', { used: 15, max: 16 })),
  ).not.toHaveClass(/is-over/)
  await editor.getByRole('button', { name: msg('crud.action.save'), exact: true }).click()
  await expect(page.getByText(msg('crud.msg.updated'))).toBeVisible()
  expect(saves).toEqual(['POST'])
  await expect(editor.getByText(msg('wxoa.menu.notice.draft'))).toBeVisible()
  const res = await request.get('/api/wxoa/menus', {
    headers: { Authorization: await bearer(request) },
    params: { accountId: account.id },
  })
  const menus = ((await res.json()) as { data: { menuKind: string; buttons: unknown }[] }).data
  expect(menus).toEqual([
    expect.objectContaining({
      menuKind: 'default',
      buttons: [{ name: '一二三四五', kind: 'click', key: 'E2E_MENU_KEY' }],
    }),
  ])

  // publishing asks first, then calls the publish route once
  let published = 0
  await page.route('**/api/wxoa/menus/*/publish', (route) => {
    published++
    return route.fulfill(ok())
  })
  await editor.getByRole('button', { name: msg('wxoa.menu.publish.action'), exact: true }).click()
  await page
    .getByRole('dialog', { name: msg('crud.confirm.title') })
    .getByRole('button', { name: msg('wxoa.menu.publish.action'), exact: true })
    .click()
  await expect(
    page.locator('.el-message').filter({ hasText: msg('wxoa.menu.publish.done') }),
  ).toBeVisible()
  expect(published).toBe(1)
})
