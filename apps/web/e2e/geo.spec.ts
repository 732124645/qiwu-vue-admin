import { expect, msg, signIn, test } from './fixtures.ts'

// Acceptance: the division tree expands to the county level; looking up 8.8.8.8
// shows a place, or "unknown" when the ip2region xdb file is not installed.

test('regions: the tree expands province → city → county; an IP lookup shows its place or unknown', async ({
  page,
}) => {
  await signIn(page, 'admin', '/geo/areas')
  const tree = page.getByRole('tree', { name: msg('geo.area.tree') })
  const node = (name: string, code: string) =>
    tree.getByRole('treeitem', { name: new RegExp(`^${name}\\s*${code}`) }).first()

  await node('浙江省', '330000').getByText('浙江省', { exact: true }).click()
  await node('杭州市', '330100').getByText('杭州市', { exact: true }).click()
  const county = node('西湖区', '330106')
  await expect(county).toBeVisible()
  // the county is a leaf
  await expect(county.locator('.el-tree-node__expand-icon').first()).toHaveClass(/is-leaf/)

  // the lookup: invalid input is caught by the form, a public address answers
  const ip = page.locator('input[name=ip]')
  await ip.fill('8.8.8')
  await page.getByRole('button', { name: msg('geo.area.query') }).click()
  await expect(page.locator('.el-form-item__error')).toBeVisible()
  await ip.fill('8.8.8.8')
  await page.getByRole('button', { name: msg('geo.area.query') }).click()
  const place = page.locator('.geo-area__place')
  await expect(place).toBeVisible()
  // a place with the xdb file; without it every part is empty: "unknown"
  await expect(place).toHaveText(/\S/)
  if ((await place.textContent())?.trim() === msg('geo.area.unknown'))
    await expect(place).toHaveClass(/geo-area__place--unknown/)
})
