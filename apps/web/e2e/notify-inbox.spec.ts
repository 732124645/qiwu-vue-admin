import { USERS } from './env.ts'
import { bearer, expect, msg, signIn, test } from './fixtures.ts'

test('an operator job timeout pushes a plain-text inbox message to the root bell', async ({
  page,
  request,
}) => {
  const connected = page.waitForEvent('websocket', (ws) => ws.url().includes('/socket.io/'))
  await signIn(page, 'admin', '/home')
  await connected
  const admin = { Authorization: await bearer(request) }
  const operator = { Authorization: await bearer(request, USERS.operator) }
  const unread = async (url: string) => {
    const res = await request.get(url, { headers: admin })
    expect(res.ok(), await res.text()).toBe(true)
    return ((await res.json()) as { data: { unread: number } }).data.unread
  }
  const beforeInbox = await unread('/api/messaging/inboxes/mine/unread')
  const before = (await unread('/api/messaging/bulletins/feed')) + beforeInbox
  const bell = (n: number) =>
    page.getByRole('button', {
      name: n ? msg('notify.bell.labelUnread', 'zh-CN', { count: n }) : msg('notify.bell.label'),
      exact: true,
    })
  await expect(bell(before)).toBeVisible()

  const name = `e2e-inbox-timeout-${Date.now()}`
  const created = await request.post('/api/scheduler/tasks', {
    headers: operator,
    data: {
      name,
      handler: 'demo.echo',
      params: JSON.stringify({ delayMs: 10_000 }),
      cron: '0 0 0 * * *',
      enabled: false,
      timeoutMs: 1000,
      retryMax: 0,
    },
  })
  expect(created.ok(), await created.text()).toBe(true)
  const id = ((await created.json()) as { data: { id: number } }).data.id
  try {
    const run = await request.post(`/api/scheduler/tasks/${id}/run`, { headers: operator })
    expect(run.ok(), await run.text()).toBe(true)
    await expect
      .poll(() => unread('/api/messaging/inboxes/mine/unread'), { timeout: 5000 })
      .toBe(beforeInbox + 1)
    await expect(bell(before + 1)).toBeVisible({ timeout: 2000 })
    await bell(before + 1).click()
    await page.getByRole('tab', { name: msg('notify.tabs.inbox') }).click()
    const item = page.getByRole('button', { name: new RegExp(name) })
    await expect(item).toBeVisible()
    await item.click()
    const dialog = page.getByRole('dialog', { name: new RegExp(name) })
    await expect(dialog.locator('.inbox-message-view__body')).toContainText('demo.echo')
    await expect(dialog.locator('.inbox-message-view__body')).toHaveCount(1)
    expect(await dialog.locator('.inbox-message-view__body').locator('*').count()).toBe(0)
  } finally {
    const removed = await request.delete(`/api/scheduler/tasks/${id}`, { headers: operator })
    expect(removed.ok(), await removed.text()).toBe(true)
  }
})
