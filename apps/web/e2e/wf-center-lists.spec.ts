import { spawnSync } from 'node:child_process'
import type { APIRequestContext, WebSocketRoute } from '@playwright/test'
import { serverDir, serverEnv, USERS } from './env.ts'
import {
  bearer,
  currentPage,
  expect,
  msg,
  publishModel,
  signIn,
  test,
  userId,
  type Page,
} from './fixtures.ts'

// The approval center lists of the staff user (sign-in only, own rows):
// 我的待办, 我的已办, 我的发起, 抄送我的, and the side menu's to-do count. A `wf:task` push reloads the count
// and the to-do list; the server sends it from the notification task on, so the test pushes it down the
// page's own socket (a Playwright WebSocket route in front of the real server). Nothing approves a task
// through the API here: the done row is written into the e2e database. Kept-alive lists reload
// when shown again and when the language switches (the server builds the titles in the reader's language).

const EN = 'en-US'
/** seeded-key names: the server's titles and the page's tx() translate them */
const COPIED = { modelKey: 'e2e-lists-copied', name: 'seed.dept.finance' }
const STEP = 'seed.position.engLead'
const TRIP = { modelKey: 'e2e-lists-trip', name: 'E2E trip' }
const COMMENT = 'Looks fine'
/** dict labels (seeded in the database, not in the locale files) */
const RUNNING = '审批中'
const APPROVED = '已通过'

const users = (ids: number[]) => ({ kind: 'users', ids })
const review = (id: string, name: string, ids: number[]) => ({
  id,
  type: 'review',
  name,
  assignee: users(ids),
  sign: 'any',
  whenNobody: 'autoPass',
  whenInitiatorIsReviewer: 'self',
  onReject: 'finish',
})
const begin = (next?: object) => ({ id: 'begin', type: 'begin', name: 'Begin', next })

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

/** Starts `modelKey` as `user` (a session of its own: the duplicate-submit guard keys on it). */
async function start(request: APIRequestContext, user: keyof typeof USERS, modelKey: string) {
  const res = await request.post('/api/wf/instances', {
    headers: { Authorization: await bearer(request, USERS[user]) },
    data: { modelKey },
  })
  expect(res.status(), await res.text()).toBe(201)
  return ((await res.json()) as { data: { id: number } }).data.id
}

/**
 * COPIED copies the staff user (notify) then asks them to review; TRIP asks root. Root and e2e_limited
 * start COPIED (the limited one's review marked approved), the staff user starts TRIP.
 */
const setUp = async (request: APIRequestContext) => {
  const headers = { Authorization: await bearer(request) }
  const staff = await userId(request, headers, USERS.staff.username)
  const admin = await userId(request, headers, USERS.admin.username)
  const copy = { id: 'copy', type: 'notify', name: 'E2E copy', assignee: users([staff]) }
  await publishModel(
    request,
    headers,
    COPIED,
    begin({ ...copy, next: review('check', STEP, [staff]) }),
  )
  await publishModel(request, headers, TRIP, begin(review('boss', 'E2E boss', [admin])))
  await start(request, 'admin', COPIED.modelKey)
  const limited = await start(request, 'limited', COPIED.modelKey)
  sql(
    `UPDATE wf_task SET state = 'approved', comment = ?, handled_at = UTC_TIMESTAMP(3)
      WHERE instance_id = ? AND assignee_id = ? AND state = 'pending'`,
    [COMMENT, limited, staff],
  )
  await start(request, 'staff', TRIP.modelKey)
  return { limited }
}

/** The staff user's to-do count (the API's total). */
async function todoCount(request: APIRequestContext) {
  const res = await request.get('/api/wf/tasks/todo', {
    headers: { Authorization: await bearer(request, USERS.staff) },
    params: { pageSize: 1 },
  })
  return ((await res.json()) as { data: { total: number } }).data.total
}

/** Table rows whose instance title starts with model `name` then the initiator. */
const rows = (page: Page, name: string, initiator: string) =>
  page.locator('.el-table__body tr').filter({ hasText: `${name}-${initiator}-` })

test('staff: to-dos with a live count, done, started and copied lists', async ({
  page,
  request,
}) => {
  const { limited } = await setUp(request)
  let socket: WebSocketRoute | undefined
  await page.routeWebSocket(/\/socket\.io\//, (ws) => {
    ws.connectToServer()
    socket = ws
  })
  const before = await todoCount(request)
  await signIn(page, 'staff', '/workflow/todo')
  await expect(currentPage(page, 'menu.workflow.todo')).toBeVisible()
  const menu = page.getByRole('navigation', { name: msg('common.layout.sideMenu') })
  const badge = menu
    .getByRole('menuitem', { name: msg('menu.workflow.todo') })
    .locator('.el-badge__content')
  await expect(badge).toHaveText(String(before))

  // 我的待办: root's process (step name through tx()); the limited user's, already handled, is not
  const zhModel = msg(COPIED.name)
  const fromAdmin = rows(page, zhModel, 'Administrator')
  await expect(fromAdmin).toHaveCount(1)
  await expect(fromAdmin).toContainText(msg(STEP))
  await expect(rows(page, zhModel, USERS.limited.username)).toHaveCount(0)
  await expect(page.getByRole('button', { name: msg('crud.action.toggleSearch') })).toHaveCount(0)

  // a new to-do for the staff user; its wf:task push reloads the menu count and the list
  const next = await start(request, 'admin', COPIED.modelKey)
  await expect.poll(() => socket).toBeDefined()
  socket!.send(
    `42${JSON.stringify(['message', { type: 'wf:task', payload: { instanceId: next } }])}`,
  )
  await expect(badge).toHaveText(String(before + 1))
  await expect(fromAdmin).toHaveCount(2)

  // 我的已办: the handled task, its result and comment, the process still running
  await menu.getByRole('menuitem', { name: msg('menu.workflow.done') }).click()
  await expect(currentPage(page, 'menu.workflow.done')).toBeVisible()
  const done = rows(page, zhModel, USERS.limited.username)
  await expect(done).toHaveCount(1)
  for (const text of [msg(STEP), APPROVED, COMMENT, RUNNING]) await expect(done).toContainText(text)

  // 我的发起: the staff user's own process, by state
  await menu.getByRole('menuitem', { name: msg('menu.workflow.mine') }).click()
  await expect(currentPage(page, 'menu.workflow.mine')).toBeVisible()
  const mine = rows(page, TRIP.name, USERS.staff.username)
  await expect(mine).toContainText(RUNNING)
  await page.getByRole('combobox', { name: msg('wf.center.list.state') }).click({ force: true })
  await page.getByRole('option', { name: APPROVED, exact: true }).click()
  const searched = page.waitForRequest((r) => r.url().includes('/api/wf/instances/mine?'))
  await page.getByRole('button', { name: msg('crud.action.search'), exact: true }).click()
  expect(new URL((await searched).url()).searchParams.get('state')).toBe('approved')
  await expect(mine).toHaveCount(0)

  // 抄送我的: unread copies from the process's notify step; viewing one reads it and opens the instance
  await menu.getByRole('menuitem', { name: msg('menu.workflow.cc') }).click()
  await expect(currentPage(page, 'menu.workflow.cc')).toBeVisible()
  const copied = rows(page, zhModel, USERS.limited.username)
  await expect(copied).toContainText(msg('wf.center.list.unread'))
  await expect(copied).toContainText(msg('wf.center.list.fromStep'))
  await page.getByRole('combobox', { name: msg('wf.center.list.readState') }).click({ force: true })
  await page.getByRole('option', { name: msg('wf.center.list.unread'), exact: true }).click()
  await page.getByRole('button', { name: msg('crud.action.search'), exact: true }).click()
  await expect(copied).toHaveCount(1)
  const read = page.waitForResponse((r) => /\/api\/wf\/ccs\/\d+\/read$/.test(r.url()))
  await copied.getByRole('button', { name: msg('wf.center.list.view') }).click()
  expect((await read).status()).toBe(200)
  await expect(page).toHaveURL(new RegExp(`/workflow/instances/${limited}$`))
  // back on the kept-alive list: it reloads, the read copy leaves the unread filter
  await page.goBack()
  await expect(currentPage(page, 'menu.workflow.cc')).toBeVisible()
  await expect(copied).toHaveCount(0)
  await page.getByRole('button', { name: msg('crud.action.reset'), exact: true }).click()
  await expect(copied).toContainText(msg('wf.center.list.read'))

  // en-US: the open lists reload; titles, step names and labels in English
  await menu.getByRole('menuitem', { name: msg('menu.workflow.todo') }).click()
  await page.getByRole('button', { name: msg('common.layout.language') }).click()
  await page.getByRole('menuitem', { name: msg('common.language.enUS') }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', EN)
  const enRows = rows(page, msg(COPIED.name, EN), 'Administrator')
  await expect(enRows).toHaveCount(2)
  await expect(enRows.first()).toContainText(msg(STEP, EN))
  await expect(
    page.getByRole('button', { name: msg('wf.center.list.handle', EN) }).first(),
  ).toBeVisible()
})
