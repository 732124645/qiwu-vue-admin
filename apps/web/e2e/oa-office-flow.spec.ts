import type { Locator } from '@playwright/test'
import { expect, msg, test, watchPage, type Page } from './fixtures.ts'
import { serverDir, serverEnv } from './env.ts'
import {
  desktopScript,
  officeSignIn,
  officeToken,
  officeData,
  officeEndpoints,
  receipt,
  restoreOffice,
  seedOffice,
  type OfficeFixture,
  type OfficeKind,
} from './oa-fixtures.ts'

const run = desktopScript(serverDir, serverEnv)
let fixture: OfficeFixture
test.describe.configure({ mode: 'serial', timeout: 120_000 })
test.use({ actionTimeout: 10_000 })
test.beforeAll(() => {
  fixture = seedOffice(run, 'office_desktop')
})
test.afterAll(() => restoreOffice(run, fixture))

async function date(page: Page, scope: Locator, label: string, value: string) {
  const input = scope.getByLabel(label, { exact: true })
  await input.fill(value)
  await input.press('Enter')
  await input.press('Tab')
}
async function select(page: Page, scope: Locator, label: string, value: string) {
  const select = scope
    .locator('.el-form-item')
    .filter({ has: page.locator('label').filter({ hasText: label }) })
    .locator('.el-select')
  await select.click()
  const list = await select.getByRole('combobox').getAttribute('aria-controls')
  expect(list).toBeTruthy()
  await page.locator(`[id="${list}"]`).getByRole('option', { name: value, exact: true }).click()
}
/** 五类都从办公工作台点击发起，用用户可见控件填表并等待真实写接口。 */
async function create(page: Page, kind: OfficeKind, withFile = false) {
  await page.goto('/oa/office')
  await page
    .locator(`[data-model="${kind === 'leave' ? 'leave' : `oa-${kind}`}"]`)
    .getByRole('button', { name: msg('oa.apply') })
    .click()
  const scope =
    kind === 'generic'
      ? page.getByRole('dialog')
      : page.locator(kind === 'leave' ? '.qw-form-card' : '.oa-new')
  await expect(scope).toBeVisible()
  const field = (prop: string) =>
    msg(`field.${kind === 'leave' ? 'biz.leave' : `oa.${kind}`}.${prop}`)
  if (kind === 'leave') {
    await select(page, scope, field('leaveKind'), '事假')
    await date(page, scope, field('startAt'), '2026-12-07 09:00:00')
    await date(page, scope, field('endAt'), '2026-12-07 18:00:00')
    await scope.getByLabel(field('days'), { exact: true }).fill('1')
    await scope.getByLabel(field('reason'), { exact: true }).fill('Office leave through browser')
  } else if (kind === 'trip') {
    await scope.getByLabel(field('destination'), { exact: true }).fill('North office')
    await date(page, scope, field('startAt'), '2026-12-07 09:00:00')
    await date(page, scope, field('endAt'), '2026-12-08 18:00:00')
    await scope.getByLabel(field('reason'), { exact: true }).fill('Office trip through browser')
    await scope.getByLabel(field('estimatedAmount'), { exact: true }).fill('0.30')
  } else if (kind === 'expense') {
    await scope.getByLabel(field('reason'), { exact: true }).fill('Office expense through browser')
    await scope.getByRole('button', { name: msg('oa.expense.addItem'), exact: true }).click()
    for (const [index, amount] of ['0.10', '0.20'].entries()) {
      const item = scope.locator('.oa-expense__item').nth(index)
      await date(page, item, field('expenseDate'), '2026-12-07')
      await select(page, item, field('expenseKind'), index ? '餐饮' : '交通')
      await item.getByLabel(field('amount'), { exact: true }).fill(amount)
      await item
        .getByLabel(field('description'), { exact: true })
        .fill(index ? 'Last expense receipt' : 'First expense receipt')
    }
    await expect(scope.locator('output')).toContainText('0.30')
  } else if (kind === 'seal') {
    await select(page, scope, field('sealKind'), '公章')
    await scope.getByLabel(field('documentName'), { exact: true }).fill('Office agreement')
    await scope.getByLabel(field('purpose'), { exact: true }).fill('Office seal through browser')
    await date(page, scope, field('expectedDate'), '2026-12-07')
  } else {
    await scope.getByLabel('事项名称', { exact: true }).fill('Office equipment')
    await scope.getByLabel('事项说明', { exact: true }).fill('Office generic through browser')
    await date(page, scope, '期望日期', '2026-12-07')
  }
  if (withFile) {
    await scope.locator('input[type=file]').first().setInputFiles(receipt)
    await expect(
      scope.locator('.file-upload__name').filter({ hasText: receipt.name }),
    ).toBeVisible()
  }
  const answered = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith(`/api${officeEndpoints[kind]}`),
  )
  await scope
    .getByRole('button', {
      name: msg(
        kind === 'leave'
          ? 'biz.leave.submit'
          : kind === 'generic'
            ? 'wf.center.start.submit'
            : 'oa.create',
      ),
      exact: true,
    })
    .click()
  const res = await answered
  expect(res.status(), await res.text()).toBe(201)
  const body = (await res.json()).data as {
    id: number
    instanceId?: number
    attachmentIds?: number[]
  }
  return { id: body.id, instanceId: body.instanceId ?? body.id, fileId: body.attachmentIds?.[0] }
}
/** 办理只点击现有流程详情动作和确认弹窗，不用接口替代审批。 */
async function decide(page: Page, id: number, key: 'approve' | 'sendBack') {
  await page.goto(`/workflow/instances/${id}`)
  await page
    .locator('.wf-detail__actions')
    .getByRole('button', { name: msg(`wf.center.decide.${key}`), exact: true })
    .click()
  const dialog = page.getByRole('dialog')
  if (key === 'sendBack')
    await dialog.getByText(msg('wf.center.list.initiator'), { exact: true }).click()
  await dialog
    .getByRole('textbox', { name: msg('field.wf.task.comment') })
    .fill(key === 'approve' ? 'Office checked' : 'Please clarify the destination')
  const answered = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      /\/api\/wf\/tasks\/\d+\/(approve|send-back)$/.test(r.url()),
  )
  await dialog.getByRole('button', { name: msg(`wf.center.decide.${key}`), exact: true }).click()
  expect((await answered).status()).toBe(200)
  await expect(dialog).toBeHidden()
}

test('five browser forms reach the reviewer and write approved state back to their business documents', async ({
  page,
  browser,
  baseURL,
  request,
}, info) => {
  await officeSignIn(page, fixture.users.owner, '/oa/office')
  const boss = await browser.newPage({ baseURL })
  const problems = await watchPage(boss, baseURL)
  try {
    await officeSignIn(boss, fixture.users.boss, '/oa/office')
    const headers = await officeToken(request, fixture.users.owner)
    for (const kind of ['leave', 'trip', 'expense', 'seal', 'generic'] as OfficeKind[]) {
      const result = await create(page, kind)
      await decide(boss, result.instanceId, 'approve')
      const doc = await officeData<{ state: string }>(
        request.get(`/api${officeEndpoints[kind]}/${result.id}`, { headers }),
      )
      expect(doc.state).toBe('approved')
    }
    await page.goto('/oa/office')
    await expect(page.locator('h1')).toHaveText(msg('oa.title'))
    await page.screenshot({ path: info.outputPath('office-zh-light.png'), fullPage: true })
    await page.getByRole('button', { name: msg('common.layout.language') }).click()
    await page.getByRole('menuitem', { name: msg('common.language.enUS') }).click()
    await page.evaluate(() => localStorage.setItem('qw.app.colorScheme', 'dark'))
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US')
    await expect(page.locator('html')).toHaveClass(/dark/)
    await expect(page.locator('h1')).toHaveText(msg('oa.title', 'en-US'))
    await expect(page.locator('[data-model="oa-expense"]')).toContainText(
      msg('oa.expense.entity', 'en-US'),
    )
    await page.screenshot({ path: info.outputPath('office-en-dark.png'), fullPage: true })
  } finally {
    try {
      expect(problems, 'Reviewer CSP violations / page errors').toEqual([])
    } finally {
      await boss.close()
    }
  }
})

test('a trip with a real attachment is sent back, edited and resubmitted before final approval', async ({
  page,
  browser,
  baseURL,
  request,
}) => {
  await officeSignIn(page, fixture.users.owner, '/oa/office')
  const result = await create(page, 'trip', true)
  const boss = await browser.newPage({ baseURL })
  const problems = await watchPage(boss, baseURL)
  try {
    await officeSignIn(boss, fixture.users.boss, `/workflow/instances/${result.instanceId}`)
    const downloaded = boss.waitForEvent('download')
    await boss.locator('.file-upload__name').filter({ hasText: receipt.name }).click()
    expect((await downloaded).suggestedFilename()).toBe(receipt.name)
    await decide(boss, result.instanceId, 'sendBack')
    await page.reload()
    await page.getByRole('button', { name: msg('crud.action.edit'), exact: true }).click()
    const edit = page.getByRole('dialog')
    await edit
      .getByLabel(msg('field.oa.trip.destination'), { exact: true })
      .fill('North office, floor 2')
    await edit.getByRole('button', { name: msg('crud.action.save'), exact: true }).click()
    await expect(edit).toBeHidden()
    await page.getByRole('button', { name: msg('oa.resubmit'), exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '确定', exact: true }).click()
    await decide(boss, result.instanceId, 'approve')
    const headers = await officeToken(request, fixture.users.owner)
    const doc = await officeData<{ state: string; destination: string; attachmentIds: number[] }>(
      request.get(`/api/oa/trips/${result.id}`, { headers }),
    )
    expect(doc).toMatchObject({ state: 'approved', destination: 'North office, floor 2' })
    expect(doc.attachmentIds).toHaveLength(1)
    const other = await officeToken(request, fixture.users.other)
    expect(
      (
        await request.get(`/api/storage/objects/${doc.attachmentIds[0]}/metadata`, {
          headers: other,
        })
      ).status(),
    ).toBe(403)
    expect(
      (
        await request.get(`/api/storage/objects/${doc.attachmentIds[0]}/content`, {
          headers: other,
        })
      ).status(),
    ).toBe(403)
  } finally {
    try {
      expect(problems, 'Reviewer CSP violations / page errors').toEqual([])
    } finally {
      await boss.close()
    }
  }
})
