import { expect, test, type Page } from '@playwright/test'
import { bearer, data, serverScript, signIn, type Headers, type User } from './env'

// H5 使用浏览器合成麦克风，验证消息、持久化和权限界面；不代表 App 硬件或真实媒体服务验收。
test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
})
const A: User = { username: 'm_media_a', password: 'E2e-Pass@2026' }
const B: User = { username: 'm_media_b', password: 'E2e-Pass@2026' }
let roomId = 0,
  headersB: Headers
const SEED = `
import { DataSource } from 'typeorm'
import { withTenant } from './dist/core/context/tenant.js'
import { dataSourceOptions } from './dist/db/data-source.js'
import { seedLimitedUser } from './dist/db/seeds/iam/iam.seed.js'
const ds = await new DataSource(dataSourceOptions()).initialize()
try {
  const ids = await withTenant(1, () => ds.transaction(async (q) => {
    const ids = []
    for (const user of JSON.parse(process.env.USERS)) ids.push(await seedLimitedUser(q, user.username, user.password))
    return ids
  }))
  console.log(JSON.stringify(ids))
} finally { await ds.destroy() }
`
test.beforeAll(async ({ request }) => {
  const ids = JSON.parse(
    serverScript(SEED, { USERS: JSON.stringify([A, B]) })
      .trim()
      .split('\n')
      .at(-1)!,
  ) as number[]
  headersB = await bearer(request, B)
  roomId = (
    await data<{ roomId: number }>(
      request.post('/api/im/rooms/directs', { data: { peerId: ids[0] }, headers: headersB }),
    )
  ).roomId
})

async function enterRoom(page: Page) {
  await page.goto('/')
  await signIn(page, A)
  await page.goto(`/#/pages-im/room/index?id=${roomId}`)
  await expect(page.locator('.qw-im-input')).toBeVisible()
}
async function record(page: Page, keyboard = false) {
  await page.locator('.qw-im-tool--more').click()
  const button = page.getByRole('button', { name: '语音消息', exact: true })
  if (keyboard) {
    await button.focus()
    await expect(button).toBeFocused()
    await button.press('Enter')
  } else await button.click()
  await expect(page.locator('.qw-im-recording')).toContainText(/录音中 [1-9]\d* 秒/)
  await page.getByRole('button', { name: '完成并发送', exact: true }).click()
}
type Entry = { seq: number; kind: string; attachment: { durationMs?: number; mime: string } | null }

test('voice recording sends a real WAV and the receiving member sees the server duration', async ({
  page,
  request,
}) => {
  await enterRoom(page)
  const sent = page.waitForRequest(
    (r) =>
      r.method() === 'POST' &&
      new URL(r.url()).pathname === `/api/im/rooms/${roomId}/entries` &&
      r.postDataJSON().kind === 'voice',
  )
  await record(page, true)
  const body = (await sent).postDataJSON() as Record<string, unknown>
  expect(Object.keys(body).sort()).toEqual(['clientEntryId', 'kind', 'objectId'])
  const bubble = page.locator('.qw-im-entry--mine:not(.qw-im-pending) .qw-im-voice').last()
  await expect(bubble).toContainText('播放语音')
  const result = await data<{ items: Entry[] }>(
    request.get(`/api/im/rooms/${roomId}/entries`, { headers: headersB }),
  )
  const entry = result.items.filter((item) => item.kind === 'voice').at(-1)!
  expect(entry.attachment?.mime).toBe('audio/wav')
  expect(entry.attachment?.durationMs).toBeGreaterThan(0)
  await expect(bubble).toContainText(`${Math.ceil(entry.attachment!.durationMs! / 1000)} 秒`)
  await bubble.click()
  await expect(bubble).toContainText('停止播放')
  await page.goBack()
  await expect(page.locator('.qw-im-recording')).toHaveCount(0)
})

test('a queued voice survives H5 reload as a Blob and retries without an ephemeral URL', async ({
  page,
}) => {
  await enterRoom(page)
  const block = `**/api/im/rooms/${roomId}/voice-uploads`
  await page.route(block, (route) => route.abort('failed'))
  await record(page)
  await expect(page.locator('.qw-im-pending')).toContainText('[语音]')
  await page.reload()
  await expect(page.locator('.qw-im-pending')).toContainText('[语音]')
  const stored = await page.evaluate(async () => {
    type Row = { kind: string; file?: { body?: unknown; localRef?: string } }
    type Read<T> = { result: T; error: unknown; onsuccess?: () => void; onerror?: () => void }
    type Db = {
      objectStoreNames: { contains(name: string): boolean }
      transaction(name: string): { objectStore(name: string): { getAll(): Read<Row[]> } }
      close(): void
    }
    const idb = (
      globalThis as unknown as {
        indexedDB: { databases(): Promise<{ name?: string }[]>; open(name: string): Read<Db> }
      }
    ).indexedDB
    const read = <T>(request: Read<T>) =>
      new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    for (const item of await idb.databases()) {
      if (!item.name?.startsWith('qw-im-')) continue
      const db = await read(idb.open(item.name))
      try {
        if (!db.objectStoreNames.contains('outbox')) continue
        const rows = await read(db.transaction('outbox').objectStore('outbox').getAll())
        const voice = rows.find((row) => row.kind === 'voice')
        if (voice) return { blob: voice.file?.body instanceof Blob, localRef: voice.file?.localRef }
      } finally {
        db.close()
      }
    }
    return null
  })
  expect(stored).toEqual({ blob: true, localRef: expect.stringMatching(/^v:/) })
  await page.unroute(block)
  await expect(page.locator('.qw-im-pending')).toHaveCount(0, { timeout: 15_000 })
})

test('an enabled but unconfigured call stays out of signaling and device capture', async ({
  page,
}) => {
  await page.route('**/api/im/options', async (route) => {
    const response = await route.fetch(),
      json = await response.json()
    await route.fulfill({
      response,
      json: { ...json, data: { ...json.data, callEnabled: true, callConfigured: false } },
    })
  })
  await page.route('**/api/im/calls/active', (route) =>
    route.fulfill({ json: { code: 0, msg: '', data: [] } }),
  )
  let create = 0
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/im\/rooms\/\d+\/calls$/.test(new URL(request.url()).pathname)
    )
      create++
  })
  await enterRoom(page)
  await page.locator('.qw-im-tool--more').click()
  await page.getByRole('button', { name: '发起语音通话', exact: true }).click()
  await expect(page.locator('uni-toast')).toContainText('通话服务尚未配置')
  expect(create).toBe(0)
  await expect(page.locator('.qw-call-page')).toHaveCount(0)
  await expect(page.locator('.qw-im-recording')).toHaveCount(0)
})
