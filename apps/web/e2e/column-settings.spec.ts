import { bearer, expect, msg, signIn, test, type Page } from './fixtures.ts'

// Column settings on the position list: stored per user on the server, so they survive a reload
// and follow the user to another browser; "restore defaults" goes back to the page's own columns.
const PREF = '/api/iam/profile/prefs/table.iam.position'
const DEFAULT = ['code', 'name', 'sortNo', 'enabled', 'createdAt', 'note']
const label = (prop: string) =>
  msg(prop === 'createdAt' ? 'field.common.createdAt' : `field.iam.position.${prop}`)

/** Header cells: the selection column, the shown columns, the fixed actions column. */
const expectColumns = (page: Page, props: string[]) =>
  expect(page.locator('.el-table__header th')).toHaveText([
    '',
    ...props.map(label),
    msg('crud.action.operations'),
  ])

const stored = (page: Page, method: string) =>
  page.waitForResponse((r) => r.url().endsWith(PREF) && r.request().method() === method && r.ok())

async function openSettings(page: Page) {
  await page.getByRole('button', { name: msg('crud.action.columns') }).click()
  const tree = page.getByRole('tree', { name: msg('crud.action.columns') })
  await expect(tree).toBeVisible()
  return (prop: string) =>
    tree
      .getByRole('treeitem')
      .filter({ hasText: label(prop) })
      .locator('.el-tree-node__content')
}

test('column settings: hide + move → reload keeps them, another browser too; restore defaults', async ({
  page,
  browser,
  baseURL,
  request,
}) => {
  try {
    await signIn(page, 'admin', '/iam/positions')
    await expectColumns(page, DEFAULT)

    const item = await openSettings(page)
    let saved = stored(page, 'PUT')
    await item('note').locator('.el-checkbox').click()
    await saved
    await expectColumns(page, ['code', 'name', 'sortNo', 'enabled', 'createdAt'])

    // drop onto the top edge of the first column: before it (never inside)
    saved = stored(page, 'PUT')
    await item('createdAt').dragTo(item('code'), { targetPosition: { x: 40, y: 2 } })
    await saved
    const moved = ['createdAt', 'code', 'name', 'sortNo', 'enabled']
    await expectColumns(page, moved)

    await page.reload()
    await expectColumns(page, moved)

    // the same user in another browser context reads them from the server
    const other = await browser.newContext({ baseURL, locale: 'zh-CN' })
    try {
      const second = await other.newPage()
      await signIn(second, 'admin', '/iam/positions')
      await expectColumns(second, moved)
    } finally {
      await other.close()
    }

    await openSettings(page)
    const removed = stored(page, 'DELETE')
    await page.getByRole('button', { name: msg('crud.action.resetColumns') }).click()
    await removed
    await expectColumns(page, DEFAULT)
    await page.reload()
    await expectColumns(page, DEFAULT)
  } finally {
    // a failure midway must not leave admin's settings to the later specs on the position list
    await request.delete(PREF, { headers: { Authorization: await bearer(request) } })
  }
})
