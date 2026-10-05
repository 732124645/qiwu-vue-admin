// Messages on the H5 build: my inbox paged by z-paging (newest first, more on scroll), a message's
// detail as plain text marks it read (row and tab badge follow), mark all as read, an unknown id → the
// server's 404 message; the bulletins entry, list (published only), rich-text detail and read state.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { badge, bearer, data, serverScript, signIn, tab, type Headers, type User } from './env'

/** role `demo`, no messages but the ones below */
const USER: User = { username: 'm_msg', password: 'E2e-Pass@2026' }
/** one page of 20, then 5 more on scroll; the 3 oldest are read */
const TOTAL = 25
const READ = 3
const STAMP = `e2e-${Date.now()}`
const BODY =
  '<p>First line</p><p>Second <strong>bold</strong> <img src="http://127.0.0.1:9/a.png" width="2000"></p>'

// the user, their inbox and the bulletins (two published, a draft) straight into the throwaway database:
// no admin sign-in, the sign-in rate limit (20 a minute per IP) is shared by the whole suite
const SEED = `
import { DataSource } from 'typeorm'
import { dataSourceOptions } from './dist/db/data-source.js'
import { seedLimitedUser } from './dist/db/seeds/iam/iam.seed.js'
const { USER, TOTAL, READ, STAMP, BODY } = process.env
const user = JSON.parse(USER)
const ds = await new DataSource(dataSourceOptions()).initialize()
try {
  await ds.transaction(async (q) => {
    const userId = await seedLimitedUser(q, user.username, user.password)
    await q.query('DELETE FROM msg_inbox WHERE user_id = ?', [userId])
    const start = Date.UTC(2026, 8, 1, 8, 0)
    for (let i = 1; i <= Number(TOTAL); i++)
      await q.query(
        'INSERT INTO msg_inbox (user_id, template_code, locale, category, sender_label, title, body, status, read_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [userId, 'e2e.mobile', 'zh-CN', i % 2 ? 'business' : 'system', i % 2 ? 'Ops' : null,
          'Message ' + i, 'Line one of ' + i + '\\nLine two', 'delivered',
          i <= Number(READ) ? new Date(start) : null, new Date(start + i * 60000)],
      )
    const now = Date.now()
    for (const [i, kind] of ['notice', 'announcement', 'draft'].entries())
      await q.query(
        'INSERT INTO msg_bulletin (title, kind, body, published, published_at) VALUES (?, ?, ?, ?, ?)',
        [STAMP + ' ' + kind, kind === 'draft' ? 'notice' : kind, BODY, kind === 'draft' ? 0 : 1,
          kind === 'draft' ? null : new Date(now + i * 1000)],
      )
  })
} finally {
  await ds.destroy()
}
`

const rows = (page: Page) => page.locator('.qw-msg__item')
const row = (page: Page, text: string) =>
  rows(page).filter({ has: page.locator('.qw-row__title').getByText(text, { exact: true }) })
const bulletins = (page: Page) => page.locator('.qw-bulletins__item')
const readAll = (page: Page) =>
  page.locator('.qw-msg__read-all, .qw-bulletins__read-all', { hasText: '全部已读' })
const readPosted = (page: Page) =>
  page.waitForResponse((r) => r.request().method() === 'POST' && /\/\d+\/read$/.test(r.url()))

/** the user's own API session, signed in once (beforeAll) */
let headers: Headers
const unread = async (request: APIRequestContext, url: string) =>
  (await data<{ unread: number }>(request.get(url, { headers }))).unread

test.beforeAll(async ({ request }) => {
  serverScript(SEED, {
    USER: JSON.stringify(USER),
    TOTAL: String(TOTAL),
    READ: String(READ),
    STAMP,
    BODY,
  })
  headers = await bearer(request, USER)
})

test('inbox: paged list, detail marks read, mark all as read, unknown id', async ({
  page,
  request,
}) => {
  await page.goto('/')
  await signIn(page, USER)
  await expect(badge(page, '消息')).toHaveText(String(TOTAL - READ))
  await tab(page, '消息').click()
  await expect(page).toHaveURL(/#\/pages\/message\/index$/)
  await expect(page).toHaveTitle('消息')
  await expect(page.locator('.qw-hdr__sub')).toHaveText(`${TOTAL - READ} 条未读`)

  // newest first, one page, then the rest on scroll
  await expect(rows(page)).toHaveCount(20)
  await expect(rows(page).first()).toContainText('Message 25')
  await expect(rows(page).first()).toContainText('业务 · Ops')
  await expect(row(page, 'Message 24')).toContainText('系统 · 系统')
  // z-paging now and then misses the first jump to the bottom (the footer stays "tap to load more"):
  // scroll there again, as a user would, until the next page is in
  await expect(async () => {
    await rows(page).first().scrollIntoViewIfNeeded()
    await rows(page).last().scrollIntoViewIfNeeded()
    await expect(rows(page)).toHaveCount(TOTAL, { timeout: 1000 })
  }).toPass()
  await expect(rows(page).last()).toContainText('Message 1')
  await expect(page.locator('.qw-msg__item.is-unread')).toHaveCount(TOTAL - READ)
  await expect(row(page, 'Message 1')).not.toHaveClass(/is-unread/)

  // a message: plain text with its line break, read on open
  await expect(row(page, 'Message 25')).toHaveClass(/is-unread/)
  const read = readPosted(page)
  await row(page, 'Message 25').click()
  await expect(page).toHaveURL(/#\/pages-sys\/inbox\/detail\?id=\d+$/)
  await expect(page).toHaveTitle('消息详情')
  await expect(page.locator('.qw-article__title')).toHaveText('Message 25')
  await expect(page.locator('.qw-article__meta')).toContainText('Ops')
  expect(await page.locator('.qw-article__body').innerText()).toBe('Line one of 25\nLine two')
  await read
  await page.goBack()
  await expect(page).toHaveURL(/#\/pages\/message\/index$/)
  await expect(row(page, 'Message 25')).not.toHaveClass(/is-unread/)
  await expect(rows(page)).toHaveCount(TOTAL)
  await expect(badge(page, '消息')).toHaveText(String(TOTAL - READ - 1))

  // mark all as read: rows, badge and the button follow
  await readAll(page).click()
  await expect(page.locator('.qw-msg__item.is-unread')).toHaveCount(0)
  await expect(badge(page, '消息')).toHaveCount(0)
  await expect(page.locator('.qw-hdr__sub')).toHaveText('没有未读消息')
  await expect(readAll(page)).toHaveClass(/is-disabled/)
  expect(await unread(request, '/api/messaging/inboxes/mine/unread')).toBe(0)

  // another user's or an unknown message: the server's 404, nothing shown
  await page.goto('/#/pages-sys/inbox/detail?id=999999999')
  await expect(page.locator('.qw-empty')).toBeVisible()
  await expect(page.locator('.qw-article')).toHaveCount(0)
})

test('bulletins: entry with unread badge, published list, rich-text detail, mark all as read', async ({
  page,
  request,
}) => {
  const before = await unread(request, '/api/messaging/bulletins/feed')
  expect(before).toBeGreaterThanOrEqual(2)
  await page.goto('/')
  await signIn(page, USER)
  await tab(page, '消息').click()
  const entry = page.locator('.qw-msg__bulletins')
  await expect(entry).toContainText(`${STAMP} announcement`)
  await expect(entry.locator('.qw-msg__badge')).toHaveText(String(before))

  await entry.click()
  await expect(page).toHaveURL(/#\/pages-sys\/bulletin\/index$/)
  await expect(page).toHaveTitle('公告')
  await expect(bulletins(page).first()).toContainText(`${STAMP} announcement`)
  await expect(bulletins(page).nth(1)).toContainText(`${STAMP} notice`)
  await expect(bulletins(page).nth(1)).toContainText('通知')
  await expect(bulletins(page).filter({ hasText: `${STAMP} draft` })).toHaveCount(0)

  // the sanitized HTML as rich text, images capped at the screen width; read on open
  const notice = bulletins(page).filter({ hasText: `${STAMP} notice` })
  await expect(notice).toHaveClass(/is-unread/)
  const read = readPosted(page)
  await notice.click()
  await expect(page).toHaveURL(/#\/pages-sys\/bulletin\/detail\?id=\d+$/)
  await expect(page).toHaveTitle('公告详情')
  await expect(page.locator('.qw-article__title')).toHaveText(`${STAMP} notice`)
  await expect(page.locator('.qw-article__meta')).toContainText('通知')
  const body = page.locator('.qw-article__body')
  await expect(body.locator('strong')).toHaveText('bold')
  await expect(body.locator('img')).toHaveCSS('max-width', '100%')
  await read
  await page.goBack()
  await expect(notice).not.toHaveClass(/is-unread/)

  await readAll(page).click()
  await expect(page.locator('.qw-bulletins__item.is-unread')).toHaveCount(0)
  await expect(readAll(page)).toHaveClass(/is-disabled/)
  expect(await unread(request, '/api/messaging/bulletins/feed')).toBe(0)
  await page.goBack()
  await expect(page).toHaveURL(/#\/pages\/message\/index$/)
  await expect(entry.locator('.qw-msg__badge')).toHaveCount(0)
})
