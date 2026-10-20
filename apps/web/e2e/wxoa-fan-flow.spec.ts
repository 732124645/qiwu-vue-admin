import { expect, msg, signIn, test } from './fixtures.ts'
import { ok, pickAccount, push, subscribePush, wxoaAccount, wxoaOpenId } from './wxoa.ts'

// Fans: a subscribe event pushed (signed in plain mode) to the real callback writes the fan row within
// the request, so the fan list shows it at once; the remark dialog then sends the new remark (WeChat's
// side of it is stubbed: the page's behaviour only).

test('fans: subscribe event → the fan is listed → remark', async ({ page, request }) => {
  const account = await wxoaAccount(request, 'e2e-wxoa-fan')
  const fan = wxoaOpenId()
  const res = await push(request, account, subscribePush(fan))
  expect(res.status(), await res.text()).toBe(200)
  expect(await res.text()).toBe('success')

  await signIn(page, 'admin', '/wxoa/fans')
  await pickAccount(page, account.label)
  const row = page.getByRole('row').filter({ hasText: fan })
  await expect(row).toBeVisible()
  // subscribed 是, blocked 否 (core.yes_no labels, from the DB)
  await expect(row.getByRole('cell', { name: '是', exact: true })).toHaveCount(1)
  await expect(row.getByRole('cell', { name: '否', exact: true })).toHaveCount(1)

  let sent: unknown
  await page.route('**/api/wxoa/fans/*/remark', (route) => {
    sent = route.request().postDataJSON()
    return route.fulfill(ok())
  })
  await row.getByRole('button', { name: msg('wxoa.fan.remark.action'), exact: true }).click()
  const dialog = page.getByRole('dialog', { name: msg('wxoa.fan.remark.title') })
  await dialog.getByRole('textbox', { name: msg('field.wxoa.fan.remark') }).fill('e2e VIP')
  await dialog.getByRole('button', { name: msg('crud.action.save'), exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText(msg('crud.msg.updated'))).toBeVisible()
  expect(sent).toEqual({ remark: 'e2e VIP' })
})
