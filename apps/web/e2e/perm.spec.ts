import { USERS } from './env.ts'
import { expect, msg, signIn, test } from './fixtures.ts'

test('a read-only role (iam.position.browse only) sees the list but no write controls; the API says 403', async ({
  page,
  request,
}) => {
  await signIn(page, 'reader', '/iam/positions')
  const held = page.getByRole('row').filter({ hasText: msg('seed.position.engLead') })
  await expect(held).toBeVisible()
  // enabled shows as the dict tag (core.enabled label from the DB), not a switch
  await expect(held).toContainText('启用')
  await expect(page.getByRole('switch')).toHaveCount(0)
  for (const key of [
    'crud.action.create',
    'crud.action.batchDelete',
    'crud.action.edit',
    'crud.action.delete',
  ])
    await expect(page.getByRole('button', { name: msg(key), exact: true })).toHaveCount(0)

  // hiding is display only: the server enforces the permission
  const ip = { 'X-Forwarded-For': '203.0.113.77' }
  const login = await request.post('/api/auth/login', { data: USERS.reader, headers: ip })
  const { accessToken } = (await login.json()).data
  const res = await request.post('/api/iam/positions', {
    data: { code: 'e2e-perm', name: 'e2e-perm' },
    headers: { ...ip, Authorization: `Bearer ${accessToken}` },
  })
  expect(res.status()).toBe(403)
  expect((await res.json()).code).toBe('A0430') // Err.FORBIDDEN
})

test('modify without view (editing loads GET /:id): the enabled switch but no edit button', async ({
  page,
}) => {
  await signIn(page, 'modifier', '/iam/positions')
  const held = page.getByRole('row').filter({ hasText: msg('seed.position.engLead') })
  await expect(held.getByRole('switch')).toBeChecked() // modify: the switch, not the tag
  await expect(
    page.getByRole('button', { name: msg('crud.action.edit'), exact: true }),
  ).toHaveCount(0)
})

test('users without iam.user.modify: masked contacts and no mobile search (it would reveal the digits)', async ({
  page,
}) => {
  await signIn(page, 'reader', '/iam/users')
  await expect(page.getByRole('textbox', { name: msg('field.iam.user.keyword') })).toBeVisible()
  await expect(page.getByRole('textbox', { name: msg('field.iam.user.mobile') })).toHaveCount(0)
})
