import { createRequire } from 'node:module'
import { USERS } from './env.ts'
import { bearer, expect, msg, signIn, test, type Page } from './fixtures.ts'

// Bulletins (acceptance): the admin writes one in the rich-text editor with an
// embedded image and publishes it; a bulletin injected through the API with `<img src=x onerror=…>` is
// stored and shown without the handler; a NON-admin user's header bell counts the unread ones, opening one
// shows it (the image loads for the reader) and the count drops by one. Publishing is pushed,
// so a bell open in another browser counts it at once, without a reload (its poll is a minute away).

const TITLE = 'e2e-bulletin-image'
const XSS_TITLE = 'e2e-bulletin-xss'
const field = (prop: string) => msg(`field.messaging.bulletin.${prop}`)
const row = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text })
const bell = (page: Page, unread: number) =>
  page.getByRole('button', {
    name: unread
      ? msg('notify.bell.labelUnread', 'zh-CN', { count: unread })
      : msg('notify.bell.label'),
    exact: true,
  })

/** sharp from the server's dependencies draws the image (no web dependency for a test) */
const sharp = createRequire(new URL('../../server/package.json', import.meta.url))('sharp') as (o: {
  create: { width: number; height: number; channels: 3; background: object }
}) => { png(): { toBuffer(): Promise<Buffer> } }

type Api = Parameters<typeof bearer>[0]
/** The limited user's unread count as the feed answers it. */
async function unreadOf(request: Api) {
  const res = await request.get('/api/messaging/bulletins/feed', {
    headers: { Authorization: await bearer(request, USERS.limited) },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return ((await res.json()) as { data: { unread: number } }).data.unread
}

test('bulletins: rich text with an image, published; injected handlers stripped; the reader bell counts down', async ({
  page,
  request,
}) => {
  const alerts: string[] = []
  page.on('dialog', (d) => {
    alerts.push(d.message())
    void d.dismiss()
  })

  // injected through the API (what the editor never sends): stored without the handler
  const admin = { Authorization: await bearer(request) }
  const created = await request.post('/api/messaging/bulletins', {
    headers: admin,
    data: { title: XSS_TITLE, kind: 'notice', body: '<p>hi</p><img src=x onerror=alert(1)>' },
  })
  expect(created.ok(), await created.text()).toBe(true)
  const xssId = ((await created.json()) as { data: { id: number } }).data.id
  const stored = await request.get(`/api/messaging/bulletins/${xssId}`, { headers: admin })
  const body = ((await stored.json()) as { data: { body: string } }).data.body
  expect(body).not.toMatch(/onerror|alert/)
  expect(body).toMatch(/<img src="x"\s*\/?>/)
  const published = await request.put(`/api/messaging/bulletins/${xssId}/published`, {
    headers: admin,
    data: { published: true },
  })
  expect(published.ok(), await published.text()).toBe(true)

  // the admin writes one in the editor: text and an uploaded image, then publishes it
  await signIn(page, 'admin', '/messaging/bulletins')
  await page.getByRole('button', { name: msg('crud.action.create'), exact: true }).click()
  const create = page.getByRole('dialog', {
    name: msg('crud.title.create', 'zh-CN', { name: msg('messaging.bulletin.entity') }),
  })
  await create.getByRole('textbox', { name: field('title') }).fill(TITLE)
  await create.getByRole('combobox', { name: field('kind') }).click({ force: true })
  await page.getByRole('option', { name: '公告', exact: true }).click()
  const editor = create.locator('.rich-editor [contenteditable="true"]')
  await editor.click()
  await page.keyboard.type('E2E bulletin body')
  // the toolbar follows the editor's selection a moment later: the image menu needs a caret
  const upload = create.locator('.rich-editor [data-menu-key="uploadImage"]')
  await expect(upload).not.toHaveClass(/disabled/)
  const chooser = page.waitForEvent('filechooser')
  await upload.click()
  await (
    await chooser
  ).setFiles({
    name: 'e2e-bulletin.png',
    mimeType: 'image/png',
    buffer: await sharp({
      create: { width: 120, height: 80, channels: 3, background: { r: 31, g: 111, b: 235 } },
    })
      .png()
      .toBuffer(),
  })
  await expect(editor.locator('img')).toHaveAttribute('src', /^\/files\/.+\.png$/)
  await create.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(create).toBeHidden()
  await expect(row(page, TITLE)).toBeVisible()
  await row(page, TITLE).locator('.el-switch').click()
  await expect(row(page, TITLE).getByRole('switch')).toBeChecked()

  // a reader without any bulletin permission: the bell counts both, opening one reads it
  const unread = await unreadOf(request)
  expect(unread).toBeGreaterThanOrEqual(2)
  await signIn(page, 'limited', '/home')
  await expect(bell(page, unread)).toBeVisible()
  await bell(page, unread).click()
  await page.getByRole('button', { name: TITLE }).click()
  const view = page.getByRole('dialog', { name: TITLE })
  await expect(view.getByText('E2E bulletin body')).toBeVisible()
  // the embedded image loads for the reader (a public object)
  const image = view.locator('.bulletin-view__body img')
  await expect(image).toBeVisible()
  await expect
    .poll(() =>
      image.evaluate((el) => {
        const img = el as unknown as { complete: boolean; naturalWidth: number }
        return img.complete && img.naturalWidth
      }),
    )
    .toBe(120)
  await expect(bell(page, unread - 1)).toBeVisible()
  await view.getByRole('button', { name: msg('notify.bulletin.close'), exact: true }).click()
  await expect(view).toBeHidden()

  // the injected one: shown without its handler, nothing runs
  await bell(page, unread - 1).click()
  await page.getByRole('button', { name: XSS_TITLE }).click()
  const xss = page.getByRole('dialog', { name: XSS_TITLE })
  await expect(xss.getByText('hi', { exact: true })).toBeVisible()
  await expect(xss.locator('.bulletin-view__body img')).toHaveAttribute('src', 'x')
  await expect(xss.locator('[onerror]')).toHaveCount(0)
  await expect(bell(page, unread - 2)).toBeAttached()
  expect(alerts).toEqual([])
  expect(await unreadOf(request)).toBe(unread - 2)
})

test('bulletins: publishing reaches the bell of another browser at once, without a reload', async ({
  browser,
  request,
}) => {
  const context = await browser.newContext()
  try {
    const other = await context.newPage()
    const connected = other.waitForEvent('websocket', (ws) => ws.url().includes('/socket.io/'))
    await signIn(other, 'limited', '/home')
    await connected
    const unread = await unreadOf(request)
    await expect(bell(other, unread)).toBeVisible()

    const admin = { Authorization: await bearer(request) }
    const created = await request.post('/api/messaging/bulletins', {
      headers: admin,
      data: { title: 'e2e-bulletin-push', kind: 'notice', body: '<p>pushed</p>' },
    })
    expect(created.ok(), await created.text()).toBe(true)
    const id = ((await created.json()) as { data: { id: number } }).data.id
    const published = await request.put(`/api/messaging/bulletins/${id}/published`, {
      headers: admin,
      data: { published: true },
    })
    expect(published.ok(), await published.text()).toBe(true)
    await expect(bell(other, unread + 1)).toBeVisible({ timeout: 3000 })
  } finally {
    await context.close()
  }
})
