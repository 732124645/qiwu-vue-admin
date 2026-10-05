import { currentPage, expect, msg, signIn, test, type Page } from './fixtures.ts'

// Acceptance: the four monitor pages render their dashboards and charts without
// console errors; after switching to en-US the charts' own texts (ECharts' generated aria description)
// are English.

const EN = 'en-US'

async function switchLanguage(page: Page, from: string, to: string) {
  await page.getByRole('button', { name: msg('common.layout.language', from) }).click()
  await page
    .getByRole('menuitem', { name: msg(`common.language.${to === EN ? 'enUS' : 'zhCN'}`) })
    .click()
  await expect(page.locator('html')).toHaveAttribute('lang', to)
}

/** The ECharts charts of the page: the chart root carries the generated description as its label. */
const charts = (page: Page) => page.locator('[aria-label^="这是"], [aria-label^="This is a chart"]')

test('server, Redis, cache and MySQL pages render without console errors; chart texts follow en-US', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })

  await signIn(page, 'admin', '/monitor/server')
  for (const gauge of ['cpu', 'mem', 'heap'])
    await expect(page.locator(`[data-gauge="${gauge}"] .el-progress svg`)).toBeVisible()
  await expect(
    page.getByText(msg('monitor.common.updatedAt', 'zh-CN', { time: '' }).trim()),
  ).toBeVisible()

  await page.goto('/monitor/mysql')
  for (const gauge of ['connections', 'bufferPool', 'pool'])
    await expect(page.locator(`[data-gauge="${gauge}"] .el-progress svg`)).toBeVisible()
  await expect(page.locator('[data-stat="version"] dd')).not.toBeEmpty()

  await page.goto('/monitor/cache')
  const namespaces = page.locator('.cache-monitor__ns')
  await expect(namespaces.getByText(msg('monitor.cache.ns.dict'), { exact: true })).toBeVisible()
  await namespaces.getByText(msg('monitor.cache.ns.authSession'), { exact: true }).click()
  // the admin's own session is there; its value is never shown (masked namespace)
  await expect(
    page.getByRole('heading', {
      name: msg('monitor.cache.keysOf', 'zh-CN', { name: msg('monitor.cache.ns.authSession') }),
    }),
  ).toBeVisible()
  await expect(page.locator('.cache-monitor__keys .el-table__row').first()).toBeVisible()

  await page.goto('/monitor/redis')
  await expect(page.locator('[data-stat="version"] dd')).not.toBeEmpty()
  // memory, operations, commands: three charts with their Chinese description
  await expect(charts(page)).toHaveCount(3)
  for (const title of ['field.monitor.redis.memory', 'monitor.redis.ops'])
    await expect(page.locator(`[aria-label^="这是"][aria-label*="${msg(title)}"]`)).toHaveCount(1)
  await expect(page.locator('.monitor-redis__chart svg').first()).toBeVisible()

  // the language switch rebuilds the charts in English
  await switchLanguage(page, 'zh-CN', EN)
  await expect(page.locator('[aria-label^="This is a chart"]')).toHaveCount(3)
  await expect(page.locator('[aria-label^="这是"]')).toHaveCount(0)
  await expect(
    page.locator(`[aria-label*="${msg('field.monitor.redis.memory', EN)}"]`),
  ).toHaveCount(1)
  await expect(currentPage(page, 'menu.monitor.redis', EN)).toBeVisible()

  expect(errors, 'console errors').toEqual([])
})
