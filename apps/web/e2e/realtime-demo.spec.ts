import { USERS } from './env.ts'
import { currentPage, expect, msg, signIn, test, watchPage, type Page } from './fixtures.ts'

// Acceptance: on the realtime demo page the admin pushes text to another
// browser (its own context, e2e_rt: the page only), which shows it within 2 s and as plain text; the
// connection badge follows the socket: after the network drops and comes back it reads "connected"
// again and pushes arrive on the new socket.

// the badge (the text box's character counter is a status too)
const status = (page: Page) => page.locator('.demo-realtime__status').getByRole('status')
const statusText = (key: 'up' | 'reconnecting') => msg(`demo.realtime.status.${key}`)

/** Types `text` into the send form (the users picked stay) and sends it; resolves with the answer. */
async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: msg('field.demo.realtime.text') }).fill(text)
  const answer = page.waitForResponse((r) => r.url().endsWith('/api/demo/realtime/send'))
  await page.getByRole('button', { name: msg('demo.realtime.send.submit'), exact: true }).click()
  return answer
}

test('realtime demo: the admin pushes to another browser within 2 s; its socket recovers after going offline', async ({
  page,
  browser,
  baseURL,
}) => {
  const context = await browser.newContext()
  try {
    // the receiver: e2e_rt on the page, connected; without demo.realtime.send it has no send form
    const other = await context.newPage()
    const problems = await watchPage(other, baseURL)
    await signIn(other, 'rt', '/demo/realtime')
    await expect(currentPage(other, 'menu.demo.realtime')).toBeVisible()
    await expect(status(other)).toHaveText(statusText('up'))
    await expect(other.getByRole('button', { name: msg('demo.realtime.send.submit') })).toHaveCount(
      0,
    )

    // the sender: the admin picks e2e_rt
    await signIn(page, 'admin', '/demo/realtime')
    await expect(status(page)).toHaveText(statusText('up'))
    await page.getByRole('button', { name: msg('picker.user.title'), exact: true }).click()
    const picker = page.getByRole('dialog', { name: msg('picker.user.title') })
    await picker
      .getByRole('textbox', { name: msg('field.iam.user.keyword') })
      .fill(USERS.rt.username)
    // a click on the row picks (display name = username for the e2e users)
    await picker.getByRole('cell', { name: USERS.rt.username, exact: true }).first().click()
    await expect(picker.getByRole('checkbox', { name: USERS.rt.username })).toBeChecked()
    await picker.getByRole('button', { name: msg('picker.user.confirm'), exact: true }).click()
    await expect(picker).toBeHidden()

    // markup travels and shows as text: no element is made of it
    const text = `<b>e2e-rt ${Date.now()}</b>`
    const answer = send(page, text)
    const item = other.getByRole('listitem').filter({ hasText: text })
    await expect(item).toBeVisible({ timeout: 2000 })
    await expect(item.getByText(text, { exact: true })).toBeVisible()
    await expect(item.locator('b')).toHaveCount(0)
    await expect(item).toContainText('Administrator')
    const res = await answer
    expect(((await res.json()) as { data: { delivered: number } }).data.delivered).toBe(1)
    // sent to e2e_rt only: the admin's own log stays empty
    await expect(page.getByText(msg('demo.realtime.log.empty'), { exact: true })).toBeVisible()

    // the network drops: Socket.IO retries; back online, the new socket is in the user's room again
    await context.setOffline(true)
    await expect(status(other)).toHaveText(statusText('reconnecting'))
    await context.setOffline(false)
    await expect(status(other)).toHaveText(statusText('up'), { timeout: 10_000 })
    const again = `e2e-rt again ${Date.now()}`
    await send(page, again)
    await expect(other.getByRole('listitem').filter({ hasText: again })).toBeVisible({
      timeout: 2000,
    })
    await expect(other.getByRole('listitem').filter({ hasText: 'e2e-rt' })).toHaveCount(2)
    expect(problems, 'CSP violations / page errors (receiver)').toEqual([])
  } finally {
    await context.close()
  }
})
