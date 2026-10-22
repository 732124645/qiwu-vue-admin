import { expect, test } from '@playwright/test'
import { bearer, serverScript, signIn } from './env'
import { comment, detailUrl, open, openAs, sheet, state, submit } from './wf'
import {
  createOfficeRequest,
  officeData,
  restoreOffice,
  seedOffice,
  uploadOffice,
  type OfficeFixture,
} from '../../apps/web/e2e/oa-fixtures'

let fixture: OfficeFixture
test.describe.configure({ mode: 'serial', timeout: 60_000 })
test.beforeAll(() => {
  fixture = seedOffice(serverScript, 'office_mobile')
})
test.afterAll(() => restoreOffice(serverScript, fixture))

test('the mobile reviewer reads the last expense row and authenticated attachment before approving', async ({
  page,
  request,
}, info) => {
  const owner = await bearer(request, fixture.users.owner)
  const file = await uploadOffice(request, owner)
  const result = await createOfficeRequest(request, owner, 'expense', {
    items: [
      {
        expenseDate: '2026-12-07',
        expenseKind: 'transport',
        amount: '0.10',
        description: 'First receipt',
        attachmentIds: [],
      },
      {
        expenseDate: '2026-12-07',
        expenseKind: 'meal',
        amount: '0.20',
        description: 'Last meal receipt',
        attachmentIds: [file],
      },
    ],
  })
  await openAs(page, fixture.users.boss, result.instanceId)
  await expect(page.locator('.qw-business-summary__item')).toHaveCount(2)
  const last = page.locator('.qw-business-summary__item').last()
  await expect(last).toContainText('Last meal receipt')
  await expect(last).toContainText('0.20')
  await expect(last.locator('.qw-files__name')).toHaveText('office-receipt.pdf')
  const content = page.waitForResponse((r) =>
    r.url().endsWith(`/api/storage/objects/${file}/content`),
  )
  const download = page.waitForEvent('download')
  await last.locator('.qw-files__row .wd-button').click()
  expect((await content).status()).toBe(200)
  expect((await download).suggestedFilename()).toBe(`attachment-${file}.pdf`)
  await page.screenshot({ path: info.outputPath('mobile-expense-zh-light.png'), fullPage: true })
  await open(page, 'approve')
  await comment(page).fill('Checked both receipts')
  await submit(page)
  await expect(state(page)).toHaveText('已通过')
  expect(
    await officeData<{ state: string; totalAmount: string }>(
      request.get(`/api/oa/expense-claims/${result.id}`, { headers: owner }),
    ),
  ).toMatchObject({ state: 'approved', totalAmount: '0.30' })
  await page.goto('/#/pages/mine/index')
  await page.locator('.qw-mine__language').click()
  await page.locator('.wd-action-sheet__action', { hasText: 'English' }).click()
  await page.locator('.qw-mine__appearance').click()
  await page
    .locator('.wd-action-sheet__action')
    .filter({ has: page.locator('.wd-action-sheet__name', { hasText: /^Dark$/ }) })
    .click()
  await page.goto(`/#/pages-wf/detail/index?id=${result.instanceId}`)
  await page.reload()
  await expect(page.locator('html')).toHaveClass(/qw-dark/)
  await expect(page.locator('uni-page-body')).toHaveCSS('background-color', 'rgb(8, 13, 22)')
  await expect(page).toHaveTitle('Approval detail')
  await expect(state(page)).toHaveText('Approved')
  await expect(page.locator('.qw-business-summary__item').last()).toContainText('Last meal receipt')
  await page.screenshot({ path: info.outputPath('mobile-expense-en-dark.png'), fullPage: true })
})

test('send-back and rejection use the real mobile decision sheets and foreign viewers have no decision controls', async ({
  page,
  request,
}) => {
  const owner = await bearer(request, fixture.users.owner)
  const trip = await createOfficeRequest(request, owner, 'trip', {
    reason: 'Clarify the visit plan',
  })
  await openAs(page, fixture.users.boss, trip.instanceId)
  await open(page, 'sendBack')
  await sheet(page).locator('.qw-decide__to .wd-radio').filter({ hasText: '发起人' }).click()
  await comment(page).fill('Please clarify the visit')
  await submit(page)
  const detail = await officeData<{ myTasks: { type: string }[] }>(
    request.get(`/api/wf/instances/${trip.instanceId}`, { headers: owner }),
  )
  expect(detail.myTasks.some((task) => task.type === 'begin')).toBe(true)
  const seal = await createOfficeRequest(request, owner, 'seal')
  await openAs(page, fixture.users.boss, seal.instanceId)
  await open(page, 'reject')
  await comment(page).fill('Agreement needs correction')
  await submit(page)
  await expect(state(page)).toHaveText('已驳回')
  expect(
    await officeData<{ state: string }>(
      request.get(`/api/oa/seal-requests/${seal.id}`, { headers: owner }),
    ),
  ).toMatchObject({ state: 'rejected' })
  await page.evaluate(() => localStorage.clear())
  await page.goto('about:blank')
  await page.goto('/')
  await signIn(page, fixture.users.other)
  await page.goto(detailUrl(seal.instanceId))
  await expect(page.locator('.qw-empty')).toContainText('请求的资源不存在')
  await expect(page.locator('.qw-decide-bar')).toHaveCount(0)
})
