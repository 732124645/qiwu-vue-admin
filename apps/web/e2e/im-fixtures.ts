// Chat specs' helpers (not a spec): their own staff accounts in the e2e database, sign-in, the /api/im
// requests a page makes, the local chat databases of a page, and the shared chat client bundled for
// page.evaluate (the IndexedDB cache contract runs in the real browser).
import { fileURLToPath } from 'node:url'
import type { APIRequestContext, BrowserContext, Page, Request } from '@playwright/test'
import { build } from 'vite'
import { desktopScript, type ScriptRunner } from './oa-fixtures.ts'
import { clientIp, expect, msg, watchPage } from './fixtures.ts'

export const IM_PASSWORD = 'Im-E2e@2026'
export type ImUser = { username: string; password: string; id: number }

const SEED = `
import bcrypt from 'bcryptjs'
import { DataSource } from 'typeorm'
import { withTenant } from './dist/core/context/tenant.js'
import { dataSourceOptions } from './dist/db/data-source.js'
import { insertRow } from './dist/db/seeds/upsert.js'
const input = JSON.parse(process.env.IM_INPUT)
const ds = await new DataSource(dataSourceOptions()).initialize()
try {
 const tid = input.code ? Number((await ds.query('SELECT id FROM iam_tenant WHERE code = ? AND deleted_at IS NULL', [input.code]))[0].id) : 1
 const users = await withTenant(tid, () => ds.transaction(async q => {
  const role = await insertRow(q, 'iam_role', {code: input.tag, name: input.tag, data_scope: 'own_rows'})
  const [home] = await q.query("SELECT id FROM iam_menu WHERE route_name = 'home' AND deleted_at IS NULL")
  await insertRow(q, 'iam_role_menus', {role_id: role, menu_id: home.id})
  const hash = await bcrypt.hash(input.password, 4)
  const out = []
  for (const name of input.names) {
   const username = input.tag + '_' + name
   const id = await insertRow(q, 'iam_user', {username, display_name: username, password_hash: hash, password_changed_at: new Date()})
   await insertRow(q, 'iam_user_roles', {user_id: id, role_id: role})
   out.push({username, password: input.password, id})
  }
  return {tid, role, users: out}
 }))
 console.log(JSON.stringify(users))
} finally { await ds.destroy() }
`

const CLEANUP = `
import { DataSource } from 'typeorm'
import { dataSourceOptions } from './dist/db/data-source.js'
const f = JSON.parse(process.env.IM_FIXTURE), ids = f.users.map(u => u.id)
const ds = await new DataSource(dataSourceOptions()).initialize()
try { await ds.transaction(async q => {
 const rooms = (await q.query('SELECT DISTINCT room_id FROM im_roster WHERE tenant_id = ? AND user_id IN (?)', [f.tid, ids])).map(r => r.room_id)
 if (rooms.length) for (const table of ['im_entry', 'im_roster']) await q.query('DELETE FROM ' + table + ' WHERE tenant_id = ? AND room_id IN (?)', [f.tid, rooms])
 if (rooms.length) await q.query('DELETE FROM im_room WHERE tenant_id = ? AND id IN (?)', [f.tid, rooms])
 await q.query('DELETE FROM im_sticker WHERE tenant_id = ? AND user_id IN (?)', [f.tid, ids])
 await q.query('UPDATE fs_object SET deleted_at = NOW(3) WHERE tenant_id = ? AND uploader_id IN (?) AND deleted_at IS NULL', [f.tid, ids])
 await q.query('DELETE FROM iam_user_roles WHERE tenant_id = ? AND user_id IN (?)', [f.tid, ids])
 await q.query('DELETE FROM iam_role_menus WHERE tenant_id = ? AND role_id = ?', [f.tid, f.role])
 await q.query('DELETE FROM iam_user WHERE tenant_id = ? AND id IN (?)', [f.tid, ids])
 await q.query('DELETE FROM iam_role WHERE tenant_id = ? AND id = ?', [f.tid, f.role])
}) } finally { await ds.destroy() }
`

export type ImFixture = { tid: number; role: number; users: ImUser[] }

/** Staff accounts `<tag>_<name>` (display name = username) holding the home page alone, in tenant `code`. */
export function seedImUsers(
  run: ScriptRunner,
  tag: string,
  names: string[],
  code?: string,
): ImFixture {
  const out = run(SEED, {
    IM_INPUT: JSON.stringify({ tag, names, password: IM_PASSWORD, code }),
  })
  return JSON.parse(out.trim().split('\n').at(-1)!) as ImFixture
}

/** Drops the accounts with their rooms, messages and stickers. */
export function cleanupIm(run: ScriptRunner, fixture: ImFixture | undefined) {
  if (fixture) run(CLEANUP, { IM_FIXTURE: JSON.stringify(fixture) })
}

export { desktopScript }

/** Signs `user` in through the API on the page's context and opens `path` (as the e2e `signIn`). */
export async function imSignIn(page: Page, user: ImUser, path = '/im/chat', tenantCode?: string) {
  const res = await page.request.post('/api/auth/login', {
    data: {
      username: user.username,
      password: user.password,
      ...(tenantCode ? { tenantCode } : {}),
    },
    headers: { 'X-Forwarded-For': clientIp() },
  })
  expect(res.ok(), await res.text()).toBe(true)
  await page.goto('/login')
  await page.evaluate(`localStorage.setItem('qw.auth.session', '1')`)
  await page.goto(path)
}

/** A bearer header of `user` for direct API calls. */
export async function imBearer(request: APIRequestContext, user: ImUser, tenantCode?: string) {
  const res = await request.post('/api/auth/login', {
    data: {
      username: user.username,
      password: user.password,
      ...(tenantCode ? { tenantCode } : {}),
    },
    headers: { 'X-Forwarded-For': clientIp() },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return {
    Authorization: `Bearer ${((await res.json()) as { data: { accessToken: string } }).data.accessToken}`,
  }
}

/** A new browser context (own cookies and IndexedDB) with one watched page. */
export async function newChatPage(context: BrowserContext, baseURL = '') {
  const page = await context.newPage()
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': clientIp() })
  const problems = await watchPage(page, baseURL)
  return { page, problems }
}

export type ImRequest = {
  method: string
  path: string
  headers: Record<string, string>
  status?: number
}

/** Records every `/api/im` request of `page` (path + query, headers, answer status). */
export function trackIm(page: Page) {
  const log: ImRequest[] = []
  const byRequest = new Map<Request, ImRequest>()
  page.on('request', (r) => {
    const url = new URL(r.url())
    if (!url.pathname.startsWith('/api/im/')) return
    const item = { method: r.method(), path: url.pathname + url.search, headers: r.headers() }
    byRequest.set(r, item)
    log.push(item)
  })
  page.on('response', (res) => {
    const item = byRequest.get(res.request())
    if (item) item.status = res.status()
  })
  const reads = () => log.filter((r) => r.method === 'GET')
  return {
    log,
    reads,
    clear: () => log.splice(0),
    /** GET requests whose path starts with `prefix` (after `/api/im`) */
    gets: (prefix: string) => reads().filter((r) => r.path.startsWith(`/api/im${prefix}`)),
  }
}

/** Names of the local chat databases of the page's origin. */
export const imDatabases = (page: Page) =>
  page.evaluate<string[]>(`(async () =>
    (await indexedDB.databases()).map((d) => d.name || '').filter((n) => n.startsWith('qw-im-')))()`)

export type LocalRoom = {
  roomId: number
  /** upper bound of the local window of rows */
  windowHigh: number
  detail: { kind: string; label: string | null } | null
}
/** The rooms in the page's local chat database (read straight from IndexedDB). */
export const localRooms = (page: Page) =>
  page.evaluate<LocalRoom[]>(`(async () => {
    const name = (await indexedDB.databases()).map((d) => d.name).find((n) => n && n.startsWith('qw-im-'))
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(name)
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
    const rooms = await new Promise((resolve) => {
      const r = db.transaction('rooms').objectStore('rooms').getAll()
      r.onsuccess = () => resolve(r.result)
    })
    db.close()
    return rooms
  })()`)

/** Locale text with parameters (zh-CN, the e2e browsers' language). */
export const tm = (key: string, params: Record<string, string | number>) =>
  msg(key, 'zh-CN', params)

const sharedSrc = fileURLToPath(new URL('../../../packages/shared/src/', import.meta.url))
let bundle: Promise<string> | undefined
/**
 * The shared chat client (`@qiwu/shared/im-client`) built once with Vite into one ES module, kept in
 * memory (never written into the production build); a spec serves it same-origin with `page.route`.
 */
export function imClientBundle(): Promise<string> {
  bundle ??= (async () => {
    const out = await build({
      configFile: false,
      logLevel: 'silent',
      root: sharedSrc,
      build: {
        write: false,
        minify: false,
        emptyOutDir: false,
        lib: { entry: `${sharedSrc}im-client.ts`, formats: ['es'], fileName: 'im-client' },
      },
    })
    const result = (Array.isArray(out) ? out[0] : out) as unknown as { output: { code?: string }[] }
    return result.output[0]!.code!
  })()
  return bundle
}

export const IM_BUNDLE_PATH = '/__qw-im-client.js'

/** Serves the client bundle on the page's origin. */
export async function serveImClient(page: Page) {
  const body = await imClientBundle()
  await page.route(`**${IM_BUNDLE_PATH}`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body }),
  )
}

/** The room list entry whose name starts with `title` (its accessible name adds the unread count). */
export const roomItem = (page: Page, title: string) =>
  page
    .getByRole('list', { name: msg('im.rooms.label') })
    .getByRole('button', { name: new RegExp(`^${title}`) })

/** The composer text box. */
export const composer = (page: Page) =>
  page.getByRole('textbox', { name: msg('im.composer.label') })

/** Types and sends a text message with Enter. */
export async function sendText(page: Page, text: string) {
  await composer(page).fill(text)
  await expect(
    page.getByRole('button', { name: msg('im.composer.send'), exact: true }),
  ).toBeEnabled()
  await composer(page).press('Enter')
}

/** The message log of the open room. */
export const messages = (page: Page) => page.getByRole('log', { name: msg('im.pane.label') })

/** The header chat entry. */
export const chatEntry = (page: Page) =>
  page.getByRole('banner').getByRole('button', { name: new RegExp(`^${msg('im.entry')}`) })

export type { ScriptRunner }
