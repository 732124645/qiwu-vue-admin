import { expect, msg, signIn, test } from './fixtures.ts'
import { ok, pickAccount, wxoaAccount } from './wxoa.ts'

// Mass send: tags and WeChat responses are mocked at the browser boundary. The test keeps the
// real account switch and permissions, then checks target selection, preview and the confirmation gate.

test('mass: choose a tag → preview → confirm → a submitted job appears', async ({
  page,
  request,
}) => {
  const account = await wxoaAccount(request, 'e2e-wxoa-mass')
  const tag = { id: 9301, accountId: account.id, tagId: 42, name: 'E2E customers', fanCount: 3 }
  const job = {
    id: 9401,
    accountId: account.id,
    targetKind: 'tag' as const,
    tagId: tag.tagId,
    openIds: null,
    msgKind: 'text' as const,
    payload: { content: 'E2E tagged message' },
    clientMsgId: 'qw-e2e-9401',
    wxMsgId: null,
    msgDataId: null,
    jobState: 'submitted' as const,
    result: null,
    finishedAt: null,
    createdAt: '2026-10-18T00:00:00.000Z',
  }
  let previewBody: Record<string, unknown> | undefined
  let createBody: Record<string, unknown> | undefined
  let created = false

  await page.route('**/api/wxoa/tags**', (route) => route.fulfill(ok([tag])))
  await page.route('**/api/wxoa/mass-jobs**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (req.method() === 'GET' && url.pathname.endsWith('/wxoa/mass-jobs'))
      return route.fulfill(ok({ items: created ? [job] : [], total: created ? 1 : 0 }))
    if (req.method() === 'POST' && url.pathname.endsWith('/wxoa/mass-jobs/preview')) {
      previewBody = req.postDataJSON() as Record<string, unknown>
      return route.fulfill(ok({ ...job, id: 9402, jobState: 'submitted' }))
    }
    if (req.method() === 'POST' && url.pathname.endsWith('/wxoa/mass-jobs')) {
      createBody = req.postDataJSON() as Record<string, unknown>
      created = true
      return route.fulfill(ok(job))
    }
    return route.fallback()
  })

  await signIn(page, 'admin', '/wxoa/mass')
  await pickAccount(page, account.label)

  await page
    .getByRole('radio', { name: msg('wxoa.mass.target.tag'), exact: true })
    .check({ force: true })
  await page
    .getByRole('combobox', { name: msg('wxoa.mass.target.tagLabel'), exact: true })
    .click({ force: true })
  await page.getByRole('option', { name: tag.name, exact: true }).click()
  await page
    .getByRole('radio', { name: msg('wxoa.mass.kind.text'), exact: true })
    .check({ force: true })
  await page
    .getByRole('textbox', { name: msg('wxoa.mass.text'), exact: true })
    .fill('E2E tagged message')

  const previewId = page.getByRole('textbox', {
    name: msg('wxoa.mass.preview.openId'),
    exact: true,
  })
  await previewId.fill('openid-e2e-preview')
  await page.getByRole('button', { name: msg('wxoa.mass.preview.action'), exact: true }).click()
  await expect(page.getByText(msg('wxoa.mass.preview.done'))).toBeVisible()
  expect(previewBody).toMatchObject({
    accountId: account.id,
    targetKind: 'tag',
    tagId: tag.tagId,
    msgKind: 'text',
    payload: { content: 'E2E tagged message' },
    toOpenId: 'openid-e2e-preview',
  })

  await page.getByRole('button', { name: msg('wxoa.mass.send'), exact: true }).click()
  const confirm = page.getByRole('dialog', { name: msg('wxoa.mass.confirmTitle') })
  await expect(confirm).toContainText(tag.name)
  await confirm.getByRole('button', { name: msg('wxoa.mass.send'), exact: true }).click()
  await expect(page.getByText(msg('wxoa.mass.sent'))).toBeVisible()
  expect(createBody).toMatchObject({
    accountId: account.id,
    targetKind: 'tag',
    tagId: tag.tagId,
    msgKind: 'text',
    payload: { content: 'E2E tagged message' },
  })
  await expect(page.getByRole('row').filter({ hasText: job.clientMsgId })).toBeVisible()
})
