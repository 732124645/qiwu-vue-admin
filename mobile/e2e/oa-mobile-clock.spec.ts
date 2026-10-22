import { expect, test, type Page } from '@playwright/test'
import { bearer, clientIp, serverScript, signIn } from './env'
import {
  officeData,
  restoreOffice,
  seedOffice,
  type OfficeFixture,
  type OfficeUser,
} from '../../apps/web/e2e/oa-fixtures'

let fixture: OfficeFixture
const CLOCK = '/#/pages-biz/oa-clock/index'
test.describe.configure({ mode: 'serial', timeout: 60_000 })
test.use({ actionTimeout: 10_000 })
test.beforeAll(() => {
  fixture = seedOffice(serverScript, 'office_clock', { clock: true })
})
test.afterAll(() => restoreOffice(serverScript, fixture))
const button = (page: Page, text: string) =>
  page.locator('.wd-button').filter({ hasText: new RegExp(`^${text}$`) })
async function openClock(page: Page, user: OfficeUser) {
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': clientIp() })
  await page.goto('/')
  await signIn(page, user)
  await page.goto(CLOCK)
  await expect(page.locator('.qw-clock__title').first()).toHaveText('打卡')
  await expect(button(page, '上班签到')).not.toHaveClass(/is-disabled/)
}

test('native clocking without location or DingTalk records only this employee and prevents duplicate punches', async ({
  page,
  request,
}, info) => {
  await openClock(page, fixture.users.owner)
  await expect(page.locator('picker')).toHaveCount(0)
  for (const label of ['上班签到', '下班签退']) {
    const answered = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith('/api/oa/clock-records/punch'),
    )
    await button(page, label).click()
    const res = await answered
    expect(res.status(), await res.text()).toBe(201)
    expect((await res.json()).data).toMatchObject({
      source: 'native',
      validationResult: 'not_required',
      userId: fixture.users.owner.id,
    })
    await expect(button(page, label)).toHaveClass(/is-disabled/)
  }
  await expect(page.locator('.qw-clock__record')).toHaveCount(2)
  const headers = await bearer(request, fixture.users.owner)
  const today = await officeData<{ workDate: string }>(
    request.get('/api/oa/clock-records/today', { headers }),
  )
  await expect(page.locator('.qw-clock__month .qw-field__label')).toBeVisible()
  await expect(page.locator('.qw-clock__day .qw-field__label')).toBeVisible()
  await expect(page.locator('.qw-clock__month .qw-field__label')).toHaveText('月份')
  await expect(page.locator('.qw-clock__day .qw-field__label')).toHaveText('日期（可选）')
  await page.locator('.qw-clock__day input').fill(today.workDate)
  await button(page, '查询记录').click()
  await expect(page.locator('.qw-clock__record')).toHaveCount(2)
  const other = await bearer(request, fixture.users.other)
  expect(
    await officeData<{ total: number }>(
      request.get('/api/oa/clock-records/mine', { headers: other }),
    ),
  ).toMatchObject({ total: 0 })
  await page.screenshot({ path: info.outputPath('mobile-clock-zh-light.png'), fullPage: true })
  await page.goto('/#/pages/mine/index')
  await page.locator('.qw-mine__language').click()
  await page.locator('.wd-action-sheet__action', { hasText: 'English' }).click()
  await page.locator('.qw-mine__appearance').click()
  await page
    .locator('.wd-action-sheet__action')
    .filter({ has: page.locator('.wd-action-sheet__name', { hasText: /^Dark$/ }) })
    .click()
  await page.goto(CLOCK)
  await page.reload()
  await expect(page.locator('html')).toHaveClass(/qw-dark/)
  await expect(page.locator('uni-page-body')).toHaveCSS('background-color', 'rgb(8, 13, 22)')
  await expect(page.locator('.qw-clock__title').first()).toHaveText('Clock in / out')
  await expect(button(page, 'Clock in')).toHaveClass(/is-disabled/)
  await expect(page.locator('.qw-clock__record')).toHaveCount(2)
  await page.screenshot({ path: info.outputPath('mobile-clock-en-dark.png'), fullPage: true })
})

test('a lost real punch response stays unresolved offline and is recovered by querying the original request', async ({
  page,
  request,
  context,
}) => {
  await openClock(page, fixture.users.boss)
  let posts = 0
  let queryable = false
  let original = ''
  // 只模拟响应丢失和查询断网，写请求仍由真实服务器执行；不伪造任何成功响应。
  await page.route('**/api/oa/clock-records/punch', async (route) => {
    posts++
    original = route.request().postDataJSON().requestId as string
    const response = await route.fetch()
    expect(response.status(), await response.text()).toBe(201)
    await route.abort('failed')
  })
  await page.route('**/api/oa/clock-records/requests/*', async (route) => {
    if (queryable) await route.continue()
    else await route.abort('internetdisconnected')
  })
  await button(page, '上班签到').click()
  await expect(button(page, '查询本次结果')).toBeVisible()
  await expect(button(page, '上班签到')).toHaveClass(/is-disabled/)
  await expect(button(page, '下班签退')).toHaveClass(/is-disabled/)
  await context.setOffline(true)
  await button(page, '查询本次结果').click()
  await expect(page.locator('[role=alert]')).toBeVisible()
  expect(posts).toBe(1)
  await context.setOffline(false)
  queryable = true
  const queried = page.waitForResponse(
    (r) => r.url().endsWith(`/api/oa/clock-records/requests/${original}`) && r.status() === 200,
  )
  await button(page, '查询本次结果').click()
  expect((await queried).status()).toBe(200)
  await expect(button(page, '查询本次结果')).toHaveCount(0)
  await expect(button(page, '上班签到')).toHaveClass(/is-disabled/)
  await expect(button(page, '下班签退')).not.toHaveClass(/is-disabled/)
  expect(posts).toBe(1)
  const headers = await bearer(request, fixture.users.boss)
  const mine = await officeData<{ total: number; items: { requestId: string }[] }>(
    request.get('/api/oa/clock-records/mine', { headers }),
  )
  expect(mine.total).toBe(1)
  expect(mine.items[0]!.requestId).toBe(original)
})
