import { expect, msg, signIn, test } from './fixtures.ts'

// The actions column in a real browser: every row's actions fit their cell (nothing clipped into "…"),
// rows with more buttons than the visible count show a More trigger, and its menu opens on hover and
// stays open when the trigger is clicked.
const PAGES = [
  '/iam/users',
  '/iam/roles',
  '/iam/depts',
  '/iam/menus',
  '/iam/positions',
  '/settings/dicts',
  '/scheduler/tasks',
  '/oauth/clients',
  '/messaging/bulletins',
  '/codegen/tables',
  '/wf/models',
]

test('actions columns are never clipped; More opens on hover and stays open on click', async ({
  page,
}) => {
  // the shipped default (the fixture widens it for the other specs)
  await page.addInitScript(() => {
    const key = 'qw.app.settings'
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}')
    localStorage.setItem(key, JSON.stringify({ ...saved, tableActionsVisible: 2 }))
  })
  await signIn(page, 'admin', PAGES[0])
  let mores = 0
  for (const path of PAGES) {
    await page.goto(path)
    const actions = page.locator('.el-table__body .qw-table-actions')
    // a list that is empty in this database has no actions to check
    await expect(page.locator('.el-table__body-wrapper').first()).toBeVisible()
    await page.waitForLoadState('networkidle')
    if (!(await actions.count())) continue
    // wait for the measured width to settle (one animation frame after render)
    await page.waitForTimeout(300)
    const clipped = await actions.evaluateAll((els) =>
      els
        .filter((el) => el.getClientRects().length > 0)
        .map((el) => {
          const cell = el.closest('.cell')!
          const css = el.ownerDocument.defaultView!.getComputedStyle(cell)
          const inner =
            cell.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight)
          return { need: el.scrollWidth, have: inner }
        })
        .filter(({ need, have }) => need > have + 0.5),
    )
    expect(clipped, path).toEqual([])
    mores += await page.locator('.el-table__body .qw-table-more').count()
  }
  expect(mores).toBeGreaterThan(0)

  // hover opens the More menu; clicking the trigger then keeps it open
  await page.goto('/iam/menus')
  const more = page.locator('.el-table__body .qw-table-more').first()
  await more.hover()
  const menu = page.locator('.el-dropdown-menu:visible').last()
  await expect(menu).toBeVisible()
  await more.click()
  await page.waitForTimeout(400)
  await expect(menu).toBeVisible()
  await expect(menu.getByText(msg('crud.action.delete')).first()).toBeVisible()
})
