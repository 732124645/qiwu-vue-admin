import { expect, msg, test } from '../e2e/fixtures.ts'
import { TENANT_B, e2eServerEnv, serverDir } from '../e2e/env.ts'
import {
  createOfficeRequest,
  desktopScript,
  officeData,
  officeSignIn,
  officeToken,
  restoreOffice,
  seedOffice,
  uploadOffice,
  type OfficeFixture,
} from '../e2e/oa-fixtures.ts'

const run = desktopScript(serverDir, e2eServerEnv(serverDir, true))
let first: OfficeFixture
let second: OfficeFixture
test.describe.configure({ mode: 'serial', timeout: 60_000 })
test.beforeAll(() => {
  first = seedOffice(run, 'office_isolation_a')
  second = seedOffice(run, 'office_isolation_b', { code: TENANT_B.code })
})
test.afterAll(() => {
  try {
    restoreOffice(run, second)
  } finally {
    restoreOffice(run, first)
  }
})

test('the tenant workbench shows only its own applications and a foreign document cannot open', async ({
  page,
  request,
}) => {
  const a = await officeToken(request, first.users.owner)
  const b = await officeToken(request, second.users.owner, TENANT_B.code)
  const own = await createOfficeRequest(request, b, 'trip', { reason: 'Tenant B office visit' })
  const foreign = await createOfficeRequest(request, a, 'trip', {
    reason: 'Tenant A confidential visit',
  })
  await officeSignIn(page, second.users.owner, '/oa/office', TENANT_B.code)
  await page.getByRole('tab', { name: msg('oa.myRequests'), exact: true }).click()
  await expect(page.locator('.el-table__body:visible')).toContainText(msg('seed.oa.trip'))
  const mine = await officeData<{ items: { id: number }[] }>(
    request.get('/api/wf/instances/mine', { headers: b, params: { modelKey: 'oa-trip' } }),
  )
  expect(mine.items.map((item) => item.id)).toContain(own.instanceId)
  expect(mine.items.map((item) => item.id)).not.toContain(foreign.instanceId)
  const denied = page.waitForResponse(
    (r) => r.url().endsWith(`/api/oa/trips/${foreign.id}`) && r.status() !== 401,
  )
  await page.goto(`/oa/trip/${foreign.id}`)
  expect((await denied).status()).toBe(404)
  await expect(page.locator('.oa-document .el-descriptions')).toHaveCount(0)
  await expect(page.getByText('Tenant A confidential visit')).toHaveCount(0)
})

test('attachments remain private across tenants while their own workflow reviewer can download', async ({
  page,
  request,
}, info) => {
  const a = await officeToken(request, first.users.owner)
  const b = await officeToken(request, second.users.owner, TENANT_B.code)
  const file = await uploadOffice(request, a)
  const application = await createOfficeRequest(request, a, 'seal', {
    documentName: 'Tenant A private agreement',
    attachmentIds: [file],
  })
  const reviewer = await officeToken(request, first.users.boss)
  for (const endpoint of ['metadata', 'content']) {
    expect(
      (
        await request.get(`/api/storage/objects/${file}/${endpoint}`, { headers: reviewer })
      ).status(),
    ).toBe(200)
    expect(
      (await request.get(`/api/storage/objects/${file}/${endpoint}`, { headers: b })).status(),
    ).toBe(404)
  }
  const rejected = await request.post('/api/oa/seal-requests', {
    headers: b,
    data: {
      sealKind: 'company',
      documentName: 'Attempted foreign attachment',
      purpose: 'Cross tenant validation',
      copies: 1,
      expectedDate: '2026-12-07',
      attachmentIds: [file],
    },
  })
  expect(rejected.status()).toBe(400)
  await officeSignIn(page, first.users.boss, `/workflow/instances/${application.instanceId}`)
  await expect(page.locator('.oa-document .el-descriptions')).toContainText(
    'Tenant A private agreement',
  )
  await expect(page.locator('.file-upload__name')).toContainText('office-receipt.pdf')
  await page.screenshot({ path: info.outputPath('tenant-private-attachment.png'), fullPage: true })
  await officeSignIn(page, second.users.owner, '/oa/office', TENANT_B.code)
  const denied = page.waitForResponse(
    (r) => r.url().endsWith(`/api/wf/instances/${application.instanceId}`) && r.status() !== 401,
  )
  await page.goto(`/workflow/instances/${application.instanceId}`)
  expect((await denied).status()).toBe(404)
  await expect(page.locator('.wf-detail__actions')).toHaveCount(0)
})
