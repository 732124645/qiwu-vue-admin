// Acceptance of the staff chat in the browser: two staff members chat (text with emoji, image, file,
// built-in and own stickers, edit, recall, read position); the local-first client fetches nothing twice
// (a reload revalidates with If-None-Match and gets 304s, a cached room opens without /entries even with
// /entries blocked, an incoming message costs one afterSeq request, a read on another device costs none,
// a seen thumbnail is never downloaded again, the built-in sticker panel reads nothing); the IndexedDB
// cache passes the shared cache contract in the real browser; sign-out and an account switch wipe the
// local database while an expired session keeps it; with two tabs only the leader syncs and a sign-out
// in the other tab wipes for both.
import type { BrowserContext, Page } from '@playwright/test'
import { serverDir, serverEnv } from './env.ts'
import { expect, msg, test } from './fixtures.ts'
import {
  IM_BUNDLE_PATH,
  chatEntry,
  cleanupIm,
  composer,
  desktopScript,
  imBearer,
  imDatabases,
  imSignIn,
  messages,
  newChatPage,
  roomItem,
  seedImUsers,
  sendText,
  serveImClient,
  trackIm,
  localRooms,
  tm,
  type ImFixture,
} from './im-fixtures.ts'

const run = desktopScript(serverDir, serverEnv)
let fixture: ImFixture
const contexts: BrowserContext[] = []
test.describe.configure({ mode: 'serial', timeout: 120_000 })
test.use({ actionTimeout: 10_000 })

/** A 2×2 PNG (thumbnails need a decodable image). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWM4EaBxIkCDAUIBACWOBQHvtZ07AAAAAElFTkSuQmCC',
  'base64',
)
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n')

const user = (i: number) => fixture.users[i]!
async function open(context?: BrowserContext) {
  return newChatPage(context ?? (await newContext()))
}
/** List requests of a room's messages (not its attachment files). */
const listReads = (reqs: ReturnType<typeof trackIm>) =>
  reqs.reads().filter((r) => /\/rooms\/\d+\/entries\?/.test(r.path))
/** The accessible name of the user's own sticker buttons (`mineItem` with any id). */
const MINE_STICKER = new RegExp(
  `^${tm('im.composer.mineItem', { id: '__' }).replace('__', '\\d+')}$`,
)
let browserRef: import('@playwright/test').Browser
async function newContext() {
  const ctx = await browserRef.newContext()
  contexts.push(ctx)
  return ctx
}

/** Opens the direct room with `peer` from the directory. */
async function openDirect(page: Page, peer: string) {
  await page.getByRole('tab', { name: msg('im.tabs.directory') }).click()
  await page.getByRole('button', { name: tm('im.directory.chatWith', { name: peer }) }).click()
  await expect(page.getByRole('heading', { level: 2, name: peer })).toBeVisible()
}

/** The next read position report of the page. */
const readReport = (page: Page) =>
  page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith('/read'))

/** The composer's hidden file input of images or files. */
const picker = (page: Page, which: 'image' | 'file') =>
  page.locator(`.im-composer__tools input[type=file][aria-label="${msg(`im.composer.${which}`)}"]`)

test.beforeAll(({ browser }) => {
  browserRef = browser
  fixture = seedImUsers(run, `e2eimc${Date.now() % 100000}`, ['ann', 'ben', 'cat'])
})
test.afterAll(async () => {
  for (const c of contexts) await c.close()
  cleanupIm(run, fixture)
})

test('the IndexedDB cache passes the shared cache contract in the browser', async ({ page }) => {
  await imSignIn(page, user(0), '/')
  await serveImClient(page)
  const results = await page.evaluate(async (path) => {
    const m = (await import(path)) as typeof import('@qiwu/shared/im-client')
    let n = 0
    return m.runImCacheContract(() => m.openIdbCache(`qw-contract-${Date.now()}-${n++}`))
  }, IM_BUNDLE_PATH)
  expect(results.length).toBeGreaterThan(8)
  expect(results.filter((r) => r.error)).toEqual([])
})

test('two staff members chat: text, emoji, image, file, stickers, edit, recall and read', async () => {
  const [ann, ben] = [user(0), user(1)]
  const a = await open()
  const b = await open()
  await imSignIn(a.page, ann)
  await expect(chatEntry(a.page)).toBeVisible()
  await openDirect(a.page, ben.username)
  await sendText(a.page, 'hello 😀')
  await expect(messages(a.page).getByText('hello 😀', { exact: true })).toBeVisible()

  // the peer: the room shows with one unread, the header badge too; opening it reads it
  await imSignIn(b.page, ben)
  await expect(roomItem(b.page, ann.username)).toHaveAccessibleName(
    tm('im.rooms.itemUnread', { title: ann.username, count: 1 }),
  )
  await expect(chatEntry(b.page)).toHaveAccessibleName(tm('im.entryUnread', { count: 1 }))
  await roomItem(b.page, ann.username).click()
  await expect(messages(b.page).getByText('hello 😀', { exact: true })).toBeVisible()
  await expect(chatEntry(b.page)).toHaveAccessibleName(msg('im.entry'))
  await expect(roomItem(b.page, ann.username)).toHaveAccessibleName(ann.username)
  await sendText(b.page, 'hi, <b>markup</b> stays text')
  await expect(
    messages(a.page).getByText('hi, <b>markup</b> stays text', { exact: true }),
  ).toBeVisible()
  await expect(messages(a.page).locator('b')).toHaveCount(0)

  // an image (its thumbnail through an authorized blob) and a file (an authorized download)
  await picker(a.page, 'image').setInputFiles({
    name: 'dot.png',
    mimeType: 'image/png',
    buffer: PNG,
  })
  const thumb = messages(b.page).locator('.im-entry__image img')
  await expect(thumb).toBeVisible()
  await expect
    .poll(() => thumb.evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth))
    .toBeGreaterThan(0)
  expect(await thumb.getAttribute('src')).toMatch(/^blob:/)
  await picker(a.page, 'file').setInputFiles({
    name: 'notes.pdf',
    mimeType: 'application/pdf',
    buffer: PDF,
  })
  const file = messages(b.page).locator('.im-entry__file').filter({ hasText: 'notes.pdf' })
  await expect(file).toBeVisible()
  const download = b.page.waitForEvent('download')
  await file.getByRole('button', { name: msg('im.message.download') }).click()
  expect((await download).suggestedFilename()).toBe('notes.pdf')

  // a built-in sticker
  await a.page.getByRole('button', { name: msg('im.composer.sticker'), exact: true }).click()
  await a.page.getByRole('button', { name: msg('im.sticker.smile'), exact: true }).click()
  await expect(messages(b.page).getByRole('img', { name: msg('im.sticker.smile') })).toBeVisible()

  // the peer keeps the received image as an own sticker and sends it back
  await thumb.hover()
  await messages(b.page)
    .locator('.im-entry')
    .filter({ has: b.page.locator('.im-entry__image') })
    .getByRole('button', { name: msg('im.message.actions') })
    .click()
  await b.page.getByRole('menuitem', { name: msg('im.message.addSticker') }).click()
  await expect(b.page.getByText(msg('im.message.stickerAdded'))).toBeVisible()
  await b.page.getByRole('button', { name: msg('im.composer.sticker'), exact: true }).click()
  await b.page.getByRole('tab', { name: msg('im.composer.mine') }).click()
  await b.page.getByRole('button', { name: MINE_STICKER }).first().click()
  await expect(
    messages(a.page)
      .getByRole('img', { name: msg('im.preview.sticker') })
      .last(),
  ).toBeVisible()

  // edit the first text, then recall a second one: the peer's rows change in place
  const first = messages(a.page).locator('.im-entry').filter({ hasText: 'hello 😀' })
  await first.hover()
  await first.getByRole('button', { name: msg('im.message.actions') }).click()
  await a.page.getByRole('menuitem', { name: msg('im.message.edit') }).click()
  const prompt = a.page.getByRole('dialog', { name: msg('im.message.editTitle') })
  await prompt.getByRole('textbox').fill('hello again 😀')
  await prompt.getByRole('button', { name: msg('im.action.confirm') }).click()
  await expect(messages(b.page).getByText('hello again 😀', { exact: true })).toBeVisible()
  await expect(
    messages(b.page)
      .locator('.im-entry')
      .filter({ hasText: 'hello again' })
      .getByText(msg('im.message.edited')),
  ).toBeVisible()

  await sendText(a.page, 'oops')
  await expect(messages(b.page).getByText('oops', { exact: true })).toBeVisible()
  const oops = messages(a.page).locator('.im-entry').filter({ hasText: 'oops' })
  await oops.hover()
  await oops.getByRole('button', { name: msg('im.message.actions') }).click()
  await a.page.getByRole('menuitem', { name: msg('im.message.recall') }).click()
  await a.page
    .getByRole('dialog')
    .getByRole('button', { name: msg('im.action.confirm') })
    .click()
  await expect(messages(a.page).getByText(msg('im.message.recalledMine'))).toBeVisible()
  await expect(
    messages(b.page).getByText(tm('im.message.recalled', { name: ann.username })),
  ).toBeVisible()
  await expect(messages(b.page).getByText('oops', { exact: true })).toHaveCount(0)
  expect([...a.problems, ...b.problems]).toEqual([])
  await a.page.close()
  await b.page.close()
})

test('nothing is fetched twice: 304s, cached rooms, increments, reads elsewhere, seen thumbnails', async () => {
  const [ann, ben] = [user(0), user(1)]
  const ctxA = await newContext()
  const a = await open(ctxA)
  const b = await open()
  await imSignIn(b.page, ben)
  await roomItem(b.page, ann.username).click()
  // 上一场景可能已读完所有可见行，尾部只剩隐藏的撤回事件；先发可见未读消息，明确本次已读上报的前提。
  const sent = b.page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      /\/api\/im\/rooms\/\d+\/entries$/.test(new URL(r.url()).pathname),
  )
  await sendText(b.page, 'warm the local cache')
  expect((await sent).status()).toBe(201)
  // this browser's first visit fills the cache: the room's tail page, its thumbnail and sticker
  await imSignIn(a.page, ann)
  // the room's read position moves to its last visible row once it has been shown: wait for
  // it, it changes the /sync answer the reload below revalidates
  const read = readReport(a.page)
  await roomItem(a.page, ben.username).click()
  await expect(messages(a.page).locator('.im-entry__image img')).toBeVisible()
  await expect(messages(a.page).getByText('hello again 😀', { exact: true })).toBeVisible()
  expect((await read).ok()).toBe(true)

  // a reload away from the chat page: /sync revalidates (304), no details, no directory or stickers
  // (the page load before it takes in the read position written above)
  const synced = a.page.waitForResponse((r) => new URL(r.url()).pathname === '/api/im/sync')
  await a.page.goto('/')
  await synced
  let reqs = trackIm(a.page)
  await a.page.reload()
  await expect(chatEntry(a.page)).toBeVisible()
  await expect.poll(() => reqs.gets('/sync').length).toBe(1)
  const sync = reqs.gets('/sync')[0]!
  expect(sync.headers['if-none-match']).toBeTruthy()
  await expect.poll(() => reqs.gets('/sync')[0]!.status).toBe(304)
  expect(reqs.reads().filter((r) => r.path.includes('ids='))).toEqual([])
  expect(reqs.gets('/directory')).toEqual([])
  expect(reqs.gets('/stickers')).toEqual([])

  // opening chat revalidates the directory and stickers (304); the cached room opens with /entries blocked
  // (routing is installed only now: it switches the browser cache off, which sends `Cache-Control:
  // no-cache` and so turns every revalidation into a 200)
  await chatEntry(a.page).click()
  await expect.poll(() => reqs.gets('/directory').map((r) => r.status)).toEqual([304])
  await expect.poll(() => reqs.gets('/stickers').map((r) => r.status)).toEqual([304])
  await a.page.route('**/api/im/rooms/*/entries?**', (route) => route.abort())
  await roomItem(a.page, ben.username).click()
  await expect(messages(a.page).getByText('hello again 😀', { exact: true })).toBeVisible()
  expect(listReads(reqs)).toEqual([])
  await a.page.unroute('**/api/im/rooms/*/entries?**')

  // the seen thumbnail comes from the local blob cache: no file request
  await expect(messages(a.page).locator('.im-entry__image img')).toBeVisible()
  expect(reqs.reads().filter((r) => r.path.includes('/file'))).toEqual([])

  // the built-in sticker panel reads nothing
  reqs.clear()
  await a.page.getByRole('button', { name: msg('im.composer.sticker'), exact: true }).click()
  await expect(
    a.page.getByRole('button', { name: msg('im.sticker.smile'), exact: true }),
  ).toBeVisible()
  await a.page.keyboard.press('Escape')
  expect(reqs.reads()).toEqual([])

  // one message from the peer: one afterSeq request from the local upper bound, no full sync
  const upper = (await localRooms(a.page)).find((r) => r.detail?.kind === 'direct')!.windowHigh
  reqs.clear()
  await sendText(b.page, 'one more')
  await expect(messages(a.page).getByText('one more', { exact: true })).toBeVisible()
  expect(reqs.reads().map((r) => r.path)).toEqual([
    `/api/im/rooms/${await roomIdOf(a.page)}/entries?afterSeq=${upper}&limit=100`,
  ])

  // the peer recalls it: the row changes in place from the recall event alone (one afterSeq, no seqs, no tail)
  reqs.clear()
  const mine = messages(b.page).locator('.im-entry').filter({ hasText: 'one more' })
  await mine.hover()
  await mine.getByRole('button', { name: msg('im.message.actions') }).click()
  await b.page.getByRole('menuitem', { name: msg('im.message.recall') }).click()
  await b.page
    .getByRole('dialog')
    .getByRole('button', { name: msg('im.action.confirm') })
    .click()
  await expect(
    messages(a.page).getByText(tm('im.message.recalled', { name: ben.username })),
  ).toBeVisible()
  const after = reqs.reads().map((r) => r.path)
  expect(after).toHaveLength(1)
  expect(after[0]).toContain('afterSeq=')
  expect(after.some((p) => p.includes('seqs=') || /entries\?limit=/.test(p))).toBe(false)

  // a read on the user's other device: zero requests here, the unread goes away
  await a.page.goto('/')
  await expect(chatEntry(a.page)).toBeVisible()
  reqs = trackIm(a.page)
  await sendText(b.page, 'read me elsewhere')
  await expect(chatEntry(a.page)).toHaveAccessibleName(tm('im.entryUnread', { count: 1 }))
  expect(reqs.reads()).toEqual([])
  const other = await open()
  await imSignIn(other.page, ann)
  await roomItem(other.page, ben.username).click()
  await expect(messages(other.page).getByText('read me elsewhere', { exact: true })).toBeVisible()
  await expect(chatEntry(a.page)).toHaveAccessibleName(msg('im.entry'))
  expect(reqs.reads()).toEqual([])
  await other.page.close()

  // three messages while the user is away: after a reload one afterSeq request for the room
  await a.page.close()
  for (const text of ['away 1', 'away 2', 'away 3']) await sendText(b.page, text)
  await expect(messages(b.page).getByText('away 3', { exact: true })).toBeVisible()
  const back = await open(ctxA)
  reqs = trackIm(back.page)
  await back.page.goto('/im/chat')
  const readBack = readReport(back.page)
  await roomItem(back.page, ben.username).click()
  await expect(messages(back.page).getByText('away 3', { exact: true })).toBeVisible()
  expect(listReads(reqs)).toHaveLength(1)
  expect(listReads(reqs)[0]!.path).toContain('afterSeq=')
  expect(reqs.reads().filter((r) => r.path.includes('/file'))).toEqual([])
  // the shown rows are reported read (the next test counts unread from zero)
  expect((await readBack).ok()).toBe(true)
  expect([...back.problems, ...b.problems]).toEqual([])
  await back.page.close()
  await b.page.close()
})

/** The id of the user's direct room, from the page's local chat database. */
async function roomIdOf(page: Page) {
  return (await localRooms(page)).find((r) => r.detail?.kind === 'direct')!.roomId
}

test('sign-out and an account switch wipe the local database; an expired session keeps it', async () => {
  const [ann, , cat] = [user(0), user(1), user(2)]
  const ctx = await newContext()
  const { page } = await open(ctx)
  await imSignIn(page, ann)
  await expect(roomItem(page, user(1).username)).toBeVisible()
  const [name] = await imDatabases(page)
  expect(name).toMatch(/^qw-im-[0-9a-f]{16}$/)

  // the session expires (no refresh cookie any more): the page signs in again, the cache stays
  await ctx.clearCookies()
  await page.reload()
  await expect(page).toHaveURL(/\/login/)
  expect(await imDatabases(page)).toEqual([name])
  const reqs = trackIm(page)
  await imSignIn(page, ann)
  await expect(roomItem(page, user(1).username)).toBeVisible()
  await expect.poll(() => reqs.gets('/sync').length).toBeGreaterThan(0)
  expect(reqs.gets('/sync')[0]!.headers['if-none-match']).toBeTruthy()
  expect(await imDatabases(page)).toEqual([name])

  // signing in as someone else in this browser deletes the previous account's database
  await imSignIn(page, cat)
  await expect(chatEntry(page)).toBeVisible()
  await expect.poll(() => imDatabases(page)).not.toContain(name)
  await expect(page.getByRole('list', { name: msg('im.rooms.label') })).toContainText(
    msg('im.rooms.empty'),
  )

  // signing out deletes this account's database
  await page.getByRole('button', { name: msg('common.layout.userMenu') }).click()
  await page.getByRole('menuitem', { name: msg('common.action.signOut') }).click()
  await expect(page).toHaveURL(/\/login/)
  await expect.poll(() => imDatabases(page)).toEqual([])
  await page.close()
})

test('two tabs: only the leader syncs; signing out in the other tab wipes for both', async ({
  request,
}) => {
  const [ann, ben] = [user(0), user(1)]
  const ctx = await newContext()
  const first = await open(ctx)
  await imSignIn(first.page, ann)
  await expect(roomItem(first.page, ben.username)).toBeVisible()
  const second = await ctx.newPage()
  const reqs = trackIm(second)
  await second.goto('/im/chat')
  await expect(roomItem(second, ben.username)).toBeVisible()
  await expect.poll(() => reqs.gets('/options').length).toBe(1)
  expect(reqs.gets('/sync')).toEqual([])

  // a message reaches the follower through the leader's cache writes
  // the peer through its own API session (not this browser's cookies)
  const headers = await imBearer(request, ben)
  const roomId = await roomIdOf(first.page)
  const sent = await request.post(`/api/im/rooms/${roomId}/entries`, {
    headers,
    data: { clientEntryId: `tab-${Date.now()}`, kind: 'text', text: 'to both tabs' },
  })
  expect(sent.status(), await sent.text()).toBe(201)
  await expect(roomItem(second, ben.username)).toHaveAccessibleName(
    tm('im.rooms.itemUnread', { title: ben.username, count: 1 }),
  )
  expect(reqs.gets('/sync')).toEqual([])

  // signing out in the follower wipes the shared database; the leader lets go of it
  await second.getByRole('button', { name: msg('common.layout.userMenu') }).click()
  await second.getByRole('menuitem', { name: msg('common.action.signOut') }).click()
  await expect(second).toHaveURL(/\/login/)
  await expect.poll(() => imDatabases(first.page)).toEqual([])
  await expect(chatEntry(first.page)).toHaveCount(0)
  await second.close()
  await first.page.close()
})

test('composer limits: an empty or control-character text cannot be sent', async () => {
  const { page } = await open()
  await imSignIn(page, user(0))
  await roomItem(page, user(1).username).click()
  await composer(page).fill('   ')
  await expect(
    page.getByRole('button', { name: msg('im.composer.send'), exact: true }),
  ).toBeDisabled()
  await composer(page).fill('ok')
  await expect(
    page.getByRole('button', { name: msg('im.composer.send'), exact: true }),
  ).toBeEnabled()
  await page.close()
})
