// Chat on the H5 build, local first: the message tab's chat list and the tab badge (inbox + chat unread),
// a direct chat sending text, a built-in sticker (no read request for the panel) and an image, the other side
// reading them over the API; a reload renders the room from the local cache (`/sync` answers 304 to its
// If-None-Match, no `?ids=` details, no `/entries` call even while those are blocked); signing out deletes the
// chat's IndexedDB databases.
import { resolve } from 'node:path'
import { expect, test, type Page, type Request } from '@playwright/test'
import { badge, bearer, data, serverScript, signIn, tab, type Headers, type User } from './env'

/** two staff users of their own (role `demo`): A uses the app, B answers over the API */
const A: User = { username: 'm_im_a', password: 'E2e-Pass@2026' }
const B: User = { username: 'm_im_b', password: 'E2e-Pass@2026' }
const IMAGE = resolve(__dirname, '../src/pages-im/static/stickers/heart.png')

const SEED = `
import { DataSource } from 'typeorm'
import { withTenant } from './dist/core/context/tenant.js'
import { dataSourceOptions } from './dist/db/data-source.js'
import { seedLimitedUser } from './dist/db/seeds/iam/iam.seed.js'
const users = JSON.parse(process.env.USERS)
const ds = await new DataSource(dataSourceOptions()).initialize()
try {
  const ids = await withTenant(1, () => ds.transaction(async (q) => {
    const out = []
    for (const u of users) out.push(await seedLimitedUser(q, u.username, u.password))
    return out
  }))
  console.log(JSON.stringify(ids))
} finally {
  await ds.destroy()
}
`

interface Entry {
  seq: number
  kind: string
  text: string | null
  stickerCode: string | null
}

let aId = 0
let roomId = 0
let headersB: Headers
let n = 0
const clientId = () => `e2e-${Date.now().toString(36)}-${++n}`

test.beforeAll(async ({ request }) => {
  const out = serverScript(SEED, { USERS: JSON.stringify([A, B]) }).trim().split('\n').at(-1)!
  ;[aId] = JSON.parse(out) as number[]
  headersB = await bearer(request, B)
  roomId = (
    await data<{ roomId: number }>(
      request.post('/api/im/rooms/directs', { data: { peerId: aId }, headers: headersB }),
    )
  ).roomId
  for (const text of ['早上好', 'Second line 👋'])
    await data(
      request.post(`/api/im/rooms/${roomId}/entries`, {
        data: { clientEntryId: clientId(), kind: 'text', text },
        headers: headersB,
      }),
    )
})

/** the GET calls of the chat API the page makes from now on */
function record(page: Page) {
  const calls: Request[] = []
  page.on('request', (r) => {
    if (r.method() === 'GET' && r.url().includes('/api/im/')) calls.push(r)
  })
  return calls
}

/**
 * Fails every GET of a room's messages until the returned function is called. Through the DevTools
 * protocol, not `page.route`: routing switches the browser cache off, which adds `Cache-Control:
 * no-cache` to every request and so turns each If-None-Match revalidation into a full 200.
 */
async function blockEntries(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  cdp.on('Fetch.requestPaused', (e: { requestId: string; request: { method: string } }) => {
    void (e.request.method === 'GET'
      ? cdp.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' })
      : cdp.send('Fetch.continueRequest', { requestId: e.requestId }))
  })
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/im/rooms/*/entries*' }] })
  return async () => {
    await cdp.send('Fetch.disable')
    await cdp.detach()
  }
}

const mine = (page: Page) => page.locator('.qw-im-entry--mine:not(.qw-im-pending)')

test('chat: list and badge, sending from the cache-first room, reload from cache, sign-out wipes', async ({
  page,
  request,
}) => {
  // the highest read position the page reported (answered)
  let readUpTo = 0
  page.on('response', (r) => {
    if (r.request().method() !== 'PUT' || !r.url().endsWith(`/api/im/rooms/${roomId}/read`)) return
    if (r.ok()) readUpTo = Math.max(readUpTo, (r.request().postDataJSON() as { seq: number }).seq)
  })
  await page.goto('/')
  await signIn(page, A)

  await test.step('the message tab counts chat unread; the chat list shows the room', async () => {
    await expect(badge(page, '消息')).toHaveText('2')
    await tab(page, '消息').click()
    await page.locator('.qw-msg__seg .qw-seg__item', { hasText: '聊天' }).click()
    const row = page.locator('.qw-im-room', { hasText: B.username })
    await expect(row.locator('.qw-im-room__badge')).toHaveText('2')
    await expect(row.locator('.qw-msg__preview')).toHaveText('Second line 👋')
    await row.click()
    await expect(page).toHaveURL(new RegExp(`pages-im/room/index\\?id=${roomId}$`))
    await expect(page.locator('.qw-im-text')).toHaveText(['早上好', 'Second line 👋'])
  })

  let lastSeq = 0
  await test.step('text, a built-in sticker and an image go out; the other side reads them', async () => {
    await page.locator('.qw-im-input textarea').fill('你好 😀')
    await page.locator('.qw-im-send').click()
    await expect(mine(page).locator('.qw-im-text')).toHaveText('你好 😀')

    const calls = record(page)
    await page.locator('.qw-im-tool--sticker').click()
    // the first built-in sticker: smile
    const sticker = page.locator('.qw-im-sticker-item').first()
    await expect(sticker).toBeVisible()
    // the built-in panel is the subpackage's own images: no read request
    expect(calls.map((r) => r.url())).toEqual([])
    const sent = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith(`/api/im/rooms/${roomId}/entries`),
    )
    await sticker.click()
    expect((await sent).ok()).toBe(true)
    await expect(mine(page).locator('.qw-im-sticker')).toHaveCount(1)

    await page.locator('.qw-im-tool--more').click()
    const chooser = page.waitForEvent('filechooser')
    await page.locator('.qw-im-tool--image').click()
    await (await chooser).setFiles(IMAGE)
    await expect(mine(page).locator('.qw-im-image')).toHaveCount(1)
    // the thumbnail comes through the room's own file route
    await expect
      .poll(() => mine(page).locator('.qw-im-image img').getAttribute('src'))
      .toMatch(/^blob:/)

    const seen = await data<{ items: Entry[] }>(
      request.get(`/api/im/rooms/${roomId}/entries`, { headers: headersB }),
    )
    expect(seen.items.slice(-3).map((e) => [e.kind, e.text ?? e.stickerCode])).toEqual([
      ['text', '你好 😀'],
      ['sticker', 'smile'],
      ['image', null],
    ])
    lastSeq = seen.items.at(-1)!.seq
  })

  await test.step('the open room reports its last row read; a reload takes in the current state', async () => {
    // the read position and the sent rows change the /sync answer: a page load after them stores its new tag
    await expect.poll(() => readUpTo).toBe(lastSeq)
    const synced = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/im/sync')
    await page.reload()
    expect((await synced).ok()).toBe(true)
    await expect(page.locator('.qw-im-text')).toHaveText(['早上好', 'Second line 👋', '你好 😀'])
  })

  await test.step('a reload renders the room from the cache: 304 sync, no details, no entries', async () => {
    const calls = record(page)
    // proof the rows come from the cache: the room's history is not reachable at all
    const unblock = await blockEntries(page)
    const synced = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/im/sync' && !r.url().includes('ids=') && r.status() === 304,
    )
    await page.reload()
    const sync = await synced
    expect(sync.request().headers()['if-none-match']).toBeTruthy()
    await expect(page.locator('.qw-im-text')).toHaveText(['早上好', 'Second line 👋', '你好 😀'])
    await expect(mine(page).locator('.qw-im-sticker')).toHaveCount(1)
    await expect(mine(page).locator('.qw-im-image')).toHaveCount(1)
    const urls = calls.map((r) => r.url())
    expect(urls.filter((u) => u.includes('/entries'))).toEqual([])
    expect(urls.filter((u) => u.includes('/sync?ids='))).toEqual([])
    await unblock()
  })

  await test.step('signing out in another tab clears the open room and never recreates its database', async () => {
    // the page's IndexedDB (this file is typed for Node: no DOM lib)
    type Idb = { indexedDB: { databases(): Promise<{ name?: string }[]> } }
    const names = () =>
      page.evaluate(async () =>
        (await (globalThis as unknown as Idb).indexedDB.databases()).map((d) => d.name ?? ''),
      )
    expect((await names()).some((name) => name.startsWith('qw-im-'))).toBe(true)
    const other = await page.context().newPage()
    try {
      await other.goto(`/#/pages-im/room/index?id=${roomId}`)
      await expect(other.locator('.qw-im-text')).toHaveText(['早上好', 'Second line 👋', '你好 😀'])
      const calls = record(page)
      await other.goto('/#/pages/mine/index')
      await other.locator('.qw-mine__sign-out').click()
      const logout = other.waitForResponse((r) => r.url().endsWith('/api/auth/logout'))
      await other.locator('.uni-modal__btn_primary').click()
      expect((await logout).ok()).toBe(true)
      await expect(other.locator('.qw-login__title')).toBeVisible()
      await expect(page.locator('.qw-im-text')).toHaveCount(0)
      await expect(page.locator('.qw-im-image')).toHaveCount(0)
      await expect.poll(async () => (await names()).filter((name) => name.startsWith('qw-im-'))).toEqual([])
      await page.bringToFront()
      expect(calls.filter((call) => new URL(call.url()).pathname === '/api/im/options')).toEqual([])
      expect((await names()).filter((name) => name.startsWith('qw-im-'))).toEqual([])
    } finally {
      await other.close()
    }
  })
})
