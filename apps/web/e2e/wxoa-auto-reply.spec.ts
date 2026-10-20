import { expect, msg, signIn, test } from './fixtures.ts'
import { pickAccount, push, textPush, wxoaAccount, wxoaOpenId } from './wxoa.ts'

// Auto-reply: a keyword rule added on the page answers a fan's text pushed (signed in plain mode) to
// the real callback with WeChat's passive-reply XML; another text gets the bare `success`.

const field = (prop: string) => msg(`field.wxoa.replyRule.${prop}`)

test('auto-reply: add a keyword rule → push a matching text → reply XML', async ({
  page,
  request,
}) => {
  const account = await wxoaAccount(request, 'e2e-wxoa-reply')
  await signIn(page, 'admin', '/wxoa/reply-rules')
  await pickAccount(page, account.label)

  await page.getByRole('button', { name: msg('crud.action.create'), exact: true }).click()
  const create = page.getByRole('dialog', {
    name: msg('crud.title.create', 'zh-CN', { name: msg('wxoa.reply.entity') }),
  })
  await create.getByRole('textbox', { name: field('name') }).fill('e2e price rule')
  const keywords = create.getByRole('textbox', { name: field('keywords'), exact: true })
  await keywords.fill('Price')
  await keywords.press('Enter')
  await create
    .getByRole('textbox', { name: field('content'), exact: true })
    .fill('E2E 价格表 & 说明')
  await create.getByRole('button', { name: msg('crud.action.save'), exact: true }).click()
  await expect(create).toBeHidden()
  const row = page.getByRole('row').filter({ hasText: 'e2e price rule' })
  await expect(row).toContainText('Price')

  // exact match, letters in any case, surrounding blanks ignored
  const fan = wxoaOpenId()
  const res = await push(request, account, textPush(fan, '  price '))
  expect(res.status(), await res.text()).toBe(200)
  expect(res.headers()['content-type']).toMatch(/^text\/xml/)
  const xml = await res.text()
  expect(xml).toMatch(/^<xml>.*<\/xml>$/s)
  expect(xml).toContain(`<ToUserName><![CDATA[${fan}]]></ToUserName>`)
  expect(xml).toContain('<FromUserName><![CDATA[gh_e2e]]></FromUserName>')
  expect(xml).toMatch(/<CreateTime>\d{10}<\/CreateTime>/)
  expect(xml).toContain('<MsgType><![CDATA[text]]></MsgType>')
  expect(xml).toContain('<Content><![CDATA[E2E 价格表 & 说明]]></Content>')

  // no rule for this text and no default rule
  const other = await push(request, account, textPush(fan, 'price list'))
  expect(other.status()).toBe(200)
  expect(await other.text()).toBe('success')
})
