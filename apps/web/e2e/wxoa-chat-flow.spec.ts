import type { WebSocket } from '@playwright/test'
import { expect, msg, signIn, test } from './fixtures.ts'
import { ok, pickAccount, push, textPush, wxoaAccount, wxoaOpenId } from './wxoa.ts'

// Conversations: a fan's text pushed (signed in plain mode) to the real callback reaches the open
// chat page through the realtime push, without a reload; the reply goes out from the composer
// (WeChat's side of sending is stubbed: the page's behaviour only).

test('chat: a fan texts → the conversation shows up live → reply', async ({ page, request }) => {
  const account = await wxoaAccount(request, 'e2e-wxoa-chat')
  // the page's latest socket got Socket.IO's connect answer: pushes reach the page from then on (the
  // sign-in page may have had a socket of its own)
  let latest: WebSocket | undefined
  let connected = false
  page.on('websocket', (ws) => {
    latest = ws
    connected = false
    ws.on('framereceived', (f) => {
      if (ws === latest && typeof f.payload === 'string' && f.payload.startsWith('40'))
        connected = true
    })
    ws.on('close', () => {
      if (ws === latest) connected = false
    })
  })
  await signIn(page, 'admin', '/wxoa/chat')
  await pickAccount(page, account.label)
  await expect(page.getByText(msg('wxoa.chat.noConversations'))).toBeVisible()
  await expect.poll(() => connected).toBe(true)

  const fan = wxoaOpenId()
  const text = `e2e hello ${Date.now()}`
  const res = await push(request, account, textPush(fan, text))
  expect(res.status(), await res.text()).toBe(200)
  const conversations = page.getByRole('complementary', { name: msg('wxoa.chat.conversations') })
  const item = conversations.getByRole('button', { name: fan })
  await expect(item).toBeVisible({ timeout: 10_000 })

  await item.click()
  await expect(item).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('log')).toContainText(text)
  await expect(page.getByText(msg('wxoa.chat.window.inbound'))).toBeVisible()

  let sent: unknown
  await page.route('**/api/wxoa/messages', (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    sent = route.request().postDataJSON()
    return route.fulfill(ok())
  })
  const content = page.getByRole('textbox', { name: msg('field.wxoa.message.content') })
  await content.fill('e2e reply')
  await page.getByRole('button', { name: msg('wxoa.chat.composer.send'), exact: true }).click()
  await expect(content).toHaveValue('')
  expect(sent).toEqual(
    expect.objectContaining({
      accountId: account.id,
      kind: 'text',
      body: { content: 'e2e reply' },
      materialId: null,
      objectId: null,
    }),
  )
  expect((sent as { fanId: unknown }).fanId).toEqual(expect.any(Number))
})
