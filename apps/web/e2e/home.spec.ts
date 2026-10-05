import { spawnSync } from 'node:child_process'
import type { APIRequestContext } from '@playwright/test'
import { serverDir, serverEnv, USERS } from './env.ts'
import { bearer, expect, msg, publishModel, signIn, test, userId, type Page } from './fixtures.ts'

// 首页工作台: the staff user's to-do count (live over `wf:task`), requests still
// running (counted again when the kept-alive page shows again), unread inbox messages, quick entries and
// the previous sign-in's time (/me); a user without the approval center gets the inbox
// counter only. The browser runs in UTC; the sign-in history is rewritten in the e2e database.

test.use({ timezoneId: 'UTC' })

/** staff reviews it (a to-do); root reviews the staff user's request (it stays running) */
const REVIEW = { modelKey: 'e2e-home-review', name: 'E2E home review' }
const REQUEST = { modelKey: 'e2e-home-request', name: 'E2E home request' }
/** nobody reviews it: done as soon as started, never counted as running */
const NOTICE = { modelKey: 'e2e-home-notice', name: 'E2E home notice' }
const PREVIOUS = { at: '2025-03-04T05:06:07Z', shown: '2025-03-04 05:06' }

const SQL = `
import { DataSource } from 'typeorm'
import { dataSourceOptions } from './dist/db/data-source.js'
const ds = await new DataSource(dataSourceOptions()).initialize()
try { await ds.query(process.env.E2E_SQL, JSON.parse(process.env.E2E_ARGS)) } finally { await ds.destroy() }
`
/** One parameterized statement on the e2e database (the server's compiled data source). */
function sql(query: string, args: unknown[]) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', SQL], {
    cwd: serverDir,
    env: { ...process.env, ...serverEnv, E2E_SQL: query, E2E_ARGS: JSON.stringify(args) },
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`e2e sql failed: ${r.stderr}`)
}

/** The user's sign-in history: only `rows` ([kind, ok, ISO time]); the session about to start is added. */
function signInHistory(id: number, username: string, rows: [string, number, string][]) {
  sql('DELETE FROM aud_signin_log WHERE user_id = ?', [id])
  for (const [kind, ok, at] of rows)
    sql(
      `INSERT INTO aud_signin_log (kind, user_id, username, client_id, ok, msg_key, created_at)
       VALUES (?, ?, ?, 'console', ?, 'signin.ok', ?)`,
      [kind, id, username, ok, at.replace('T', ' ').replace('Z', '')],
    )
}

type Headers = Record<string, string>
const begin = (next: object) => ({ id: 'begin', type: 'begin', name: 'Begin', next })
const review = (id: number) => ({
  id: 'check',
  type: 'review',
  name: 'E2E check',
  assignee: { kind: 'users', ids: [id] },
  sign: 'any',
  whenNobody: 'autoPass',
  whenInitiatorIsReviewer: 'self',
  onReject: 'finish',
})

/** Starts `modelKey` in a session of its own (the duplicate-submit guard keys on it). */
async function start(request: APIRequestContext, user: keyof typeof USERS, modelKey: string) {
  const res = await request.post('/api/wf/instances', {
    headers: { Authorization: await bearer(request, USERS[user]) },
    data: { modelKey },
  })
  expect(res.status(), await res.text()).toBe(201)
  return ((await res.json()) as { data: { state: string } }).data.state
}

/** The staff user's counters through the API: to-dos, own running instances, unread inbox messages. */
async function counts(request: APIRequestContext, headers: Headers) {
  const data = async (url: string, params = {}) => {
    const res = await request.get(url, { headers, params })
    expect(res.ok(), await res.text()).toBe(true)
    return ((await res.json()) as { data: { total?: number; unread?: number } }).data
  }
  return {
    todo: (await data('/api/wf/tasks/todo', { pageSize: 1 })).total!,
    running: (await data('/api/wf/instances/mine', { pageSize: 1, state: 'running' })).total!,
    unread: (await data('/api/messaging/inboxes/mine/unread')).unread!,
  }
}

const tiles = (page: Page) => page.getByRole('list', { name: msg('common.home.stats.label') })
/** The counter tile (a link to its list) and its number. */
const tile = (page: Page, key: string) =>
  tiles(page).getByRole('link', { name: new RegExp(`^${msg(`common.home.stats.${key}`)}`) })
const value = (page: Page, key: string) => tile(page, key).locator('.home-stat__value')

test('staff: live to-do count, running requests, unread messages, entries and the previous sign-in', async ({
  page,
  request,
}) => {
  const admin = { Authorization: await bearer(request) }
  const staffId = await userId(request, admin, USERS.staff.username)
  const adminId = await userId(request, admin, USERS.admin.username)
  await publishModel(request, admin, REVIEW, begin(review(staffId)))
  await publishModel(request, admin, REQUEST, begin(review(adminId)))
  await publishModel(request, admin, NOTICE, { id: 'begin', type: 'begin', name: 'Begin' })
  await start(request, 'admin', REVIEW.modelKey)
  expect(await start(request, 'staff', NOTICE.modelKey)).not.toBe('running')
  await start(request, 'staff', REQUEST.modelKey)
  const staff = { Authorization: await bearer(request, USERS.staff) }
  // the assignment message reaches the inbox
  await expect.poll(async () => (await counts(request, staff)).unread).toBeGreaterThan(0)
  const before = await counts(request, staff)
  expect(before.todo).toBeGreaterThan(0)
  expect(before.running).toBeGreaterThan(0)

  // a successful sign-in, then a failure: the successful one is the previous sign-in
  signInHistory(staffId, USERS.staff.username, [
    ['password', 1, PREVIOUS.at],
    ['password', 0, '2025-03-05T00:00:00Z'],
  ])
  await signIn(page, 'staff', '/home')
  await expect(page.getByText(msg('common.home.lastSignIn'), { exact: true })).toBeVisible()
  await expect(page.locator('.home-banner time')).toHaveText(PREVIOUS.shown)
  await expect(value(page, 'todo')).toHaveText(String(before.todo))
  await expect(value(page, 'mine')).toHaveText(String(before.running))
  await expect(value(page, 'unread')).toHaveText(String(before.unread))
  // quick entries: the granted approval center pages among them
  await expect(
    page
      .locator('.home-entries')
      .getByRole('link', { name: new RegExp(`^${msg('menu.workflow.todo')}`) }),
  ).toBeVisible()

  // a new to-do: the `wf:task` push counts it at once, the assignment message too (`notify:new`)
  await start(request, 'admin', REVIEW.modelKey)
  await expect(value(page, 'todo')).toHaveText(String(before.todo + 1))
  await expect.poll(async () => (await counts(request, staff)).unread).toBe(before.unread + 1)
  await expect(value(page, 'unread')).toHaveText(String(before.unread + 1))

  // another running request meanwhile: counted again when the kept-alive page shows again
  await start(request, 'staff', REQUEST.modelKey)
  await tile(page, 'todo').click()
  await expect(page).toHaveURL(/\/workflow\/todo$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/home$/)
  await expect(value(page, 'mine')).toHaveText(String(before.running + 1))
  await tile(page, 'mine').click()
  await expect(page).toHaveURL(/\/workflow\/mine$/)
  await page.goBack()
  await tile(page, 'unread').click()
  await expect(page).toHaveURL(/\/inbox$/)
})

test('without the approval center: the inbox counter alone; no previous sign-in before the first', async ({
  page,
  request,
}) => {
  const id = await userId(request, { Authorization: await bearer(request) }, USERS.limited.username)
  signInHistory(id, USERS.limited.username, [['signout', 1, PREVIOUS.at]])
  await signIn(page, 'limited', '/home')
  await expect(tiles(page).getByRole('listitem')).toHaveCount(1)
  await expect(tile(page, 'unread')).toBeVisible()
  await expect(page.locator('.home-banner__facts')).toBeVisible()
  await expect(page.getByText(msg('common.home.lastSignIn'), { exact: true })).toHaveCount(0)
})
