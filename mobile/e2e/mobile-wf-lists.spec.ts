// Approval lists on the H5 build: the approval tab's to-dos (paged by z-paging: more on scroll, pull to
// refresh), done, started and copied lists over the approval-center APIs; the to-do count shared by the
// workbench, the tab badge, the header's summary and the to-do segment; an unread copy is marked read when
// opened; en-US labels. A row shows the model's name and a short time (`MM-DD HH:mm` this year, else
// `YYYY-MM-DD`: the rows are told apart by their dates).
import { expect, test, type Page } from '@playwright/test'
import { badge, serverScript, signIn, tab, type User } from './env'

/** role `demo`: the lists' owner; the peer (also `demo`) starts the processes that reach them */
const USER: User = { username: 'm_wf', password: 'E2e-Pass@2026' }
const PEER: User = { username: 'm_wf_peer', password: 'E2e-Pass@2026' }
/** to-dos: one a day, 1–25 August (a page of 20, then 5 more on scroll) */
const TODOS = Array.from({ length: 25 }, (_, i) => i + 1)
const COMMENT = 'Looks fine'
const NOTE = 'FYI'

// The rows go straight into the throwaway database on the seeded process `leave` (model and step names are
// seed.wf.* keys; the server titles them `{model}-{initiator}-{start date}` in the reader's language): no
// admin sign-in, the sign-in rate limit (20 a minute per IP) is shared by the whole suite. TODO_DAYS: the
// peer's processes waiting on the user; REST: also one done task, two started processes and two copies.
const SEED = `
import { DataSource } from 'typeorm'
import { dataSourceOptions } from './dist/db/data-source.js'
import { seedLimitedUser } from './dist/db/seeds/iam/iam.seed.js'
import { insertRow } from './dist/db/seeds/upsert.js'
const { USER, PEER, TODO_DAYS, REST, COMMENT, NOTE } = process.env
const ds = await new DataSource(dataSourceOptions()).initialize()
try {
  await ds.transaction(async (q) => {
    const user = JSON.parse(USER)
    const peer = JSON.parse(PEER)
    const me = await seedLimitedUser(q, user.username, user.password)
    const other = await seedLimitedUser(q, peer.username, peer.password)
    // a worker restarted after a failure seeds again: start over
    if (REST) {
      await q.query('DELETE FROM wf_task WHERE assignee_id = ?', [me])
      await q.query('DELETE FROM wf_cc WHERE user_id = ?', [me])
      await q.query('DELETE FROM wf_instance WHERE initiator_id IN (?, ?)', [me, other])
    }
    const [version] = await q.query(
      "SELECT id FROM wf_version WHERE model_key = 'leave' AND deleted_at IS NULL ORDER BY version DESC LIMIT 1",
    )
    // noon UTC: the same start date in the title whatever the reader's time zone
    const at = (month, day, hour = 12) => new Date(Date.UTC(2026, month - 1, day, hour))
    const instance = (initiator, startedAt, state = 'running') =>
      insertRow(q, 'wf_instance', {
        version_id: version.id, model_key: 'leave', initiator_id: initiator, state,
        form_values: '{}', initiator_picks: '{}', initiator_ctx: '{}', active_node_ids: '[]',
        started_at: startedAt, ended_at: state === 'running' ? null : startedAt,
      })
    const task = (instanceId, createdAt, more = {}) =>
      insertRow(q, 'wf_task', {
        instance_id: instanceId, node_id: 'supervisor', node_name: 'seed.wf.node.supervisor',
        assignee_id: me, created_at: createdAt, ...more,
      })
    for (const day of JSON.parse(TODO_DAYS)) await task(await instance(other, at(8, day)), at(8, day, 13))
    if (!REST) return
    await task(await instance(other, at(7, 1)), at(7, 1, 13), {
      state: 'approved', comment: COMMENT, handled_at: at(7, 2),
    })
    await instance(me, at(7, 3), 'approved')
    await instance(me, at(7, 4))
    await insertRow(q, 'wf_cc', {
      instance_id: await instance(other, at(7, 5)), node_id: 'supervisor', user_id: me,
      from_user_id: other, reason: NOTE, read_at: at(7, 6), created_at: at(7, 5, 13),
    })
    await insertRow(q, 'wf_cc', {
      instance_id: await instance(other, at(7, 7)), node_id: 'notify', user_id: me, created_at: at(7, 7, 13),
    })
  })
} finally {
  await ds.destroy()
}
`
const seed = (days: number[], rest = false) =>
  serverScript(SEED, {
    USER: JSON.stringify(USER),
    PEER: JSON.stringify(PEER),
    TODO_DAYS: JSON.stringify(days),
    REST: rest ? '1' : '',
    COMMENT,
    NOTE,
  })

const segment = (page: Page, name: string) => page.locator('.qw-seg__item', { hasText: name })
const rows = (page: Page) => page.locator('.qw-approval__item')
const title = (page: Page, i: number) => rows(page).nth(i).locator('.qw-row__title')
const time = (page: Page, i: number) => rows(page).nth(i).locator('.qw-row__time')

/** A finger pulling the list down from its top (z-paging on a phone listens to touches only). */
async function pullDown(page: Page) {
  // back to the list's top (a string: the Node-side tsconfig has no DOM types)
  await page.evaluate("document.querySelectorAll('.uni-scroll-view').forEach((e) => { e.scrollTop = 0 })")
  const box = (await rows(page).first().boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + 10
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  for (let i = 1; i <= 12; i++)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + i * 25 }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

test.beforeAll(() => seed(TODOS, true))

test('to-dos with the shared count, done, started, copies read on open', async ({ page }) => {
  const zhModel = '请假审批'
  await page.goto('/')
  await signIn(page, USER)
  await expect(page.locator('.qw-home__stat--todo .qw-home__value')).toHaveText('25')
  await expect(badge(page, '审批')).toHaveText('25')
  await tab(page, '审批').click()
  await expect(page).toHaveURL(/#\/pages\/approval\/index$/)
  await expect(page).toHaveTitle('审批')
  await expect(page.locator('.qw-hdr__sub')).toHaveText('25 项待你处理')
  await expect(page.locator('.qw-seg__label')).toHaveText(['待办', '已办', '我发起的', '抄送我的'])
  await expect(segment(page, '待办').locator('.qw-seg__n')).toHaveText('25')
  await expect(segment(page, '待办')).toHaveAttribute('aria-selected', 'true')

  // to-dos: newest first, the model, initiator and step through tx(); one page, the rest on scroll
  await expect(rows(page)).toHaveCount(20)
  await expect(title(page, 0)).toHaveText(zhModel)
  await expect(time(page, 0)).toContainText('08-25')
  await expect(rows(page).first()).toContainText(`${PEER.username} 发起 · 主管审批`)
  // z-paging now and then misses the first jump to the bottom: scroll there again until the page is in
  await expect(async () => {
    await rows(page).first().scrollIntoViewIfNeeded()
    await rows(page).last().scrollIntoViewIfNeeded()
    await expect(rows(page)).toHaveCount(TODOS.length, { timeout: 1000 })
  }).toPass()
  await expect(time(page, TODOS.length - 1)).toContainText('08-01')

  // a new to-do: pulling down reloads the list, and its total the badges (before the minute's poll)
  seed([26])
  const reloaded = page.waitForResponse((r) => r.url().includes('/api/wf/tasks/todo?page=1&pageSize=20'))
  await pullDown(page)
  await reloaded
  await expect(time(page, 0)).toContainText('08-26')
  await expect(badge(page, '审批')).toHaveText('26')
  await expect(segment(page, '待办').locator('.qw-seg__n')).toHaveText('26')
  await expect(page.locator('.qw-hdr__sub')).toHaveText('26 项待你处理')

  // done: the step, my result (a tag) and comment, where the process stands (text)
  await segment(page, '已办').click()
  await expect(segment(page, '已办')).toHaveAttribute('aria-selected', 'true')
  await expect(rows(page)).toHaveCount(1)
  const done = rows(page).first()
  await expect(time(page, 0)).toContainText('07-02')
  await expect(done.locator('.qw-tag')).toHaveText('已通过')
  for (const text of ['主管审批', '流程 · 审批中', COMMENT]) await expect(done).toContainText(text)

  // started: mine only, newest first, by state
  await segment(page, '我发起的').click()
  await expect(rows(page).locator('.qw-row__time')).toContainText(['07-04', '07-03'])
  await expect(title(page, 0)).toHaveText(zhModel)
  await expect(rows(page).first()).toContainText(`${USER.username} 发起`)
  await expect(rows(page).first().locator('.qw-tag')).toHaveText('审批中')
  await expect(rows(page).last().locator('.qw-tag')).toHaveText('已通过')

  // copies, newest first: from a process step (unread) and from the peer with a note (read)
  await segment(page, '抄送我的').click()
  await expect(rows(page)).toHaveCount(2)
  const unread = rows(page).first()
  await expect(time(page, 0)).toContainText('07-07')
  await expect(unread).toHaveClass(/is-unread/)
  await expect(unread.locator('.qw-dot')).toHaveAttribute('aria-label', '未读')
  await expect(unread).toContainText('流程抄送')
  const read = rows(page).last()
  await expect(read).not.toHaveClass(/is-unread/)
  await expect(read.locator('.qw-dot')).toHaveCount(0)
  await expect(read).toContainText(PEER.username)
  await expect(read).toContainText(NOTE)

  // opening the unread copy marks it read, then opens its instance; back, the reloaded list says so
  const marked = page.waitForResponse((r) => /\/api\/wf\/ccs\/\d+\/read$/.test(r.url()))
  await unread.click()
  expect((await marked).status()).toBe(200)
  await expect(page).toHaveURL(/#\/pages-wf\/detail\/index\?id=\d+$/)
  await expect(page).toHaveTitle('审批详情')
  const listed = page.waitForResponse((r) => r.url().includes('/api/wf/ccs/mine?'))
  await page.goBack()
  await listed
  await expect(page).toHaveURL(/#\/pages\/approval\/index$/)
  await expect(unread).not.toHaveClass(/is-unread/)
  await expect(page.locator('.qw-approval__item.is-unread')).toHaveCount(0)
})

test('en-US: list names, titles, steps and states in English', async ({ page }) => {
  const enModel = 'Leave approval'
  await page.goto('/')
  await page.locator('.qw-login__lang').click()
  await page.locator('.wd-action-sheet__action', { hasText: 'English' }).click()
  await signIn(page, USER)
  await tab(page, 'Approvals').click()
  await expect(page).toHaveTitle('Approvals')
  await expect(page.locator('.qw-hdr__sub')).toHaveText(/^\d+ waiting for you$/)
  await expect(page.locator('.qw-seg__label')).toHaveText(['To-dos', 'Done', 'Started', "CC'd to me"])
  await expect(title(page, 0)).toHaveText(enModel)
  await expect(rows(page).first()).toContainText(
    `Started by ${PEER.username} · Supervisor approval`,
  )

  await segment(page, 'Done').click()
  const done = rows(page).first()
  await expect(done.locator('.qw-tag')).toHaveText('Approved')
  for (const text of ['Supervisor approval', 'Process · In progress'])
    await expect(done).toContainText(text)
  await segment(page, "CC'd to me").click()
  await expect(rows(page).first()).toContainText('Process step')
})
