import type { APIRequestContext, BrowserContext, Locator, WebSocket } from '@playwright/test'
import { USERS, type OA_USERS } from './env.ts'
import {
  test as base,
  bearer,
  clientIp,
  expect,
  leaveRequest,
  msg,
  signIn,
  watchPage,
  type Page,
} from './fixtures.ts'

// Leave acceptance: the seeded process `leave` walked by its five seeded users, each
// step in a browser context of its own restored from that user's storage state. The long flow: 3 days →
// supervisor approves → the fork (> 2 days) → director sends it back to the supervisor step → the supervisor
// transfers to the deputy → the deputy adds HR before them → HR, the deputy, the director approve → the
// request is approved and its initiator, watching it, is told within 2 s (inbox push). Transfer and add-sign
// pick the colleague in their dialogs (the process UserPicker lists every enabled user, not the staff role's
// own rows). The other four: cancelled after the start; withdrawn by the supervisor before the director acts;
// sent back to the employee, opened from their to-dos, edited on the request's page (days), resubmitted, in
// the supervisor's to-dos again; 6 days → HR ∥ director, both approve.

type Oa = (typeof OA_USERS)[number]
type State = Awaited<ReturnType<BrowserContext['storageState']>>
/** the step's page and its socket.io connection (opened with the page) */
type StepBody<T> = (page: Page, socket: Promise<WebSocket | undefined>) => Promise<T>

const test = base.extend<{ stepAs: <T>(user: Oa, path: string, body: StepBody<T>) => Promise<T> }>({
  /**
   * One step: opens `path` as `user` in a fresh browser context from the user's storage state (the first
   * step signs in through the API), runs `body`, keeps the state (the refresh cookie rotates on every load:
   * an old one replayed would end the session) and closes the context. Steps nest: the outer page stays.
   */
  stepAs: async ({ browser, baseURL }, use) => {
    const states = new Map<Oa, State>()
    await use(async (user, path, body) => {
      const state = states.get(user)
      const context = await browser.newContext({
        storageState: state,
        extraHTTPHeaders: { 'X-Forwarded-For': clientIp() },
      })
      try {
        const page = await context.newPage()
        const problems = await watchPage(page, baseURL)
        const socket = page
          .waitForEvent('websocket', {
            predicate: (ws) => ws.url().includes('/socket.io/'),
            timeout: 10_000,
          })
          .catch(() => undefined)
        if (state) await page.goto(path)
        else await signIn(page, user, path)
        const out = await body(page, socket)
        states.set(user, await context.storageState())
        expect(problems, `${user}: CSP violations / page errors`).toEqual([])
        return out
      } finally {
        await context.close()
      }
    })
  },
})

test.describe.configure({ timeout: 90_000 })

const SUPERVISOR = msg('seed.wf.node.supervisor')
const DIRECTOR = msg('seed.wf.node.director')
const HR = msg('seed.wf.node.hr')
const PRINT = msg('wf.center.detail.print')
const label = (key: string) => msg(`wf.center.decide.${key}`)
const bar = (page: Page) => page.locator('.wf-detail__actions')
const button = (page: Page, key: string) =>
  bar(page).getByRole('button', { name: label(key), exact: true })
const head = (page: Page) => page.locator('.wf-detail > .el-card').first()
const doc = (page: Page) => page.locator('.leave-view')
const timeline = (page: Page) => page.locator('.wf-timeline')
const detail = (id: number) => `/workflow/instances/${id}`

/** Picks the users named `names` (display names) in UserPicker, opened by `opener`. */
async function pick(page: Page, opener: Locator, names: string[]) {
  await opener.click()
  const picker = page.getByRole('dialog', { name: msg('picker.user.title') })
  for (const name of names) {
    await picker.getByRole('textbox', { name: msg('field.iam.user.keyword') }).fill(name)
    await picker.getByRole('row').filter({ hasText: name }).click()
  }
  await picker.getByRole('button', { name: msg('picker.user.confirm'), exact: true }).click()
  await expect(picker).toBeHidden()
}

/**
 * Action `key` of the instance detail through its dialog (titled with step `step`; cancel has none): picks
 * the radio `choice` and the users named `users` (transfer: one), fills in `comment`, confirms. Resolves with
 * the time the server answered 200.
 */
async function act(
  page: Page,
  key: string,
  step: string | null,
  { choice, users, comment }: { choice?: string; users?: string[]; comment?: string } = {},
) {
  await button(page, key).click()
  const dialog = page.getByRole('dialog', { name: step ? `${label(key)} · ${step}` : label(key) })
  if (choice) await dialog.locator('.el-radio').filter({ hasText: choice }).click()
  if (users) {
    const opener =
      key === 'transfer'
        ? dialog.getByRole('button', { name: msg('picker.user.title'), exact: true })
        : dialog.getByRole('button', { name: msg('wf.designer.assignee.pickUsers') })
    await pick(page, opener, users)
  }
  if (comment)
    await dialog.getByRole('textbox', { name: msg('field.wf.task.comment') }).fill(comment)
  const answered = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      /\/api\/wf\/(tasks|instances)\/\d+\/[a-z-]+$/.test(r.url()),
  )
  await dialog.getByRole('button', { name: label(key), exact: true }).click()
  const res = await answered
  const at = Date.now()
  expect(res.status(), await res.text()).toBe(200)
  await expect(dialog).toBeHidden()
  return at
}

/** On 我的待办: the newest to-do (the list's first row) is on step `step` of instance `id`; opens it. */
async function openTodo(page: Page, id: number, step: string) {
  const row = page.locator('.el-table__body tr').first()
  await expect(row).toContainText(`${msg('seed.wf.leave')}-OA Employee-`)
  await expect(row).toContainText(step)
  await row.getByRole('button', { name: msg('wf.center.list.handle') }).click()
  await expect(page).toHaveURL(new RegExp(`${detail(id)}$`))
}

/** The unread bulletins plus inbox messages of the holder of `headers`: the bell's count. */
async function unread(request: APIRequestContext, headers: Record<string, string>) {
  let n = 0
  for (const url of ['/api/messaging/inboxes/mine/unread', '/api/messaging/bulletins/feed']) {
    const res = await request.get(url, { headers })
    expect(res.ok(), await res.text()).toBe(true)
    n += ((await res.json()) as { data: { unread: number } }).data.unread
  }
  return n
}

const bell = (page: Page, n: number) =>
  page.getByRole('button', {
    name: n ? msg('notify.bell.labelUnread', 'zh-CN', { count: n }) : msg('notify.bell.label'),
    exact: true,
  })

test('3 days through the five users: approve, send back, transfer, add-sign, approved; the employee told within 2 s', async ({
  stepAs,
  request,
}) => {
  const id = await leaveRequest(request, 3, 'e2e-leave-long')

  // the supervisor approves: over 2 days, the fork hands it to the director
  await stepAs('oaSupervisor', '/workflow/todo', async (page) => {
    await openTodo(page, id, SUPERVISOR)
    await act(page, 'approve', SUPERVISOR, { comment: 'e2e-leave: fine by me' })
    await expect(bar(page).getByRole('button')).toHaveText([label('withdraw'), PRINT])
  })
  // the director sends it back to the supervisor step
  await stepAs('oaDirector', '/workflow/todo', async (page) => {
    await openTodo(page, id, DIRECTOR)
    await act(page, 'sendBack', DIRECTOR, { choice: SUPERVISOR })
    await expect(bar(page).getByRole('button')).toHaveText([PRINT])
  })
  // the supervisor, holding the step again, transfers it to the deputy
  await stepAs('oaSupervisor', detail(id), async (page) => {
    await act(page, 'transfer', SUPERVISOR, { users: ['OA Deputy'] })
    await expect(timeline(page)).toContainText('OA Deputy')
    // nothing left: the step is the deputy's, the first approval made a task handled since (sent back)
    await expect(bar(page).getByRole('button')).toHaveText([PRINT])
  })
  // the deputy adds HR before them: the deputy's task waits for HR
  await stepAs('oaDeputy', '/workflow/todo', async (page) => {
    await openTodo(page, id, SUPERVISOR)
    await act(page, 'addSign', SUPERVISOR, { users: ['OA HR'] })
    await expect(button(page, 'approve')).toHaveCount(0)
    await expect(button(page, 'removeSign')).toBeVisible()
  })
  // HR approves (an add-sign task: approve, cc, comment), then the deputy
  await stepAs('oaHr', '/workflow/todo', async (page) => {
    await openTodo(page, id, SUPERVISOR)
    await expect(bar(page).getByRole('button')).toHaveText([
      label('approve'),
      label('cc'),
      label('comment'),
      PRINT,
    ])
    await act(page, 'approve', SUPERVISOR)
  })
  await stepAs('oaDeputy', detail(id), async (page) => {
    await act(page, 'approve', SUPERVISOR, { comment: 'e2e-leave: deputy ok' })
    await expect(bar(page).getByRole('button')).toHaveText([label('withdraw'), PRINT])
  })

  // the employee watches the request while the director approves: the inbox push within 2 s
  const employee = { Authorization: await bearer(request, USERS.oaEmployee) }
  // notifications take the account language: leave-form.spec leaves the employee's on en-US
  const zh = await request.put('/api/iam/profile/locale', {
    headers: employee,
    data: { locale: 'zh-CN' },
  })
  expect(zh.ok(), await zh.text()).toBe(true)
  const before = await unread(request, employee)
  await stepAs('oaEmployee', detail(id), async (page, socket) => {
    expect(await socket, 'the employee page has no socket').toBeTruthy()
    await expect(head(page)).toContainText('审批中')
    await expect(bell(page, before)).toBeVisible()
    // watched from before the approval, polled at most 500 ms apart: late, never early
    const told = bell(page, before + 1)
      .waitFor({ timeout: 30_000 })
      .then(
        () => Date.now(),
        () => Infinity,
      )
    const approvedAt = await stepAs('oaDirector', '/workflow/todo', async (director) => {
      await openTodo(director, id, DIRECTOR)
      return act(director, 'approve', DIRECTOR)
    })
    expect((await told) - approvedAt, 'the bell counted the push after 2 s').toBeLessThan(2000)

    // the newest message is the approval of this request (an earlier spec may have left one of the same
    // title: opened by its time); the request itself reads 已通过
    const res = await request.get('/api/messaging/inboxes/mine', {
      headers: employee,
      params: { page: 1, pageSize: 1, sort: '-createdAt,-id' },
    })
    expect(res.ok(), await res.text()).toBe(true)
    const [newest] = ((await res.json()) as { data: { items: { createdAt: string }[] } }).data.items
    await bell(page, before + 1).click()
    await page.getByRole('tab', { name: msg('notify.tabs.inbox') }).click()
    const title = `已通过：${msg('seed.wf.leave')}`
    await page
      .getByRole('button', { name: new RegExp(title) })
      .filter({ has: page.locator(`time[datetime="${newest!.createdAt}"]`) })
      .click()
    const message = page.getByRole('dialog', { name: new RegExp(title) })
    await expect(message.locator('.inbox-message-view__body')).toContainText(`编号 ${id}`)
    await page.reload()
    await expect(head(page)).toContainText('已通过')
    await expect(doc(page)).toContainText('已通过')
    for (const name of ['OA Supervisor', 'OA Director', 'OA Deputy', 'OA HR'])
      await expect(timeline(page)).toContainText(name)
  })
})

test('cancelled by the employee after the start: the supervisor has nothing left', async ({
  stepAs,
  request,
}) => {
  const id = await leaveRequest(request, 2, 'e2e-leave-cancel')
  await stepAs('oaEmployee', detail(id), async (page) => {
    await act(page, 'cancel', null, { comment: 'e2e-leave: plans changed' })
    await expect(head(page)).toContainText('已撤销')
    await expect(doc(page)).toContainText('已撤销')
    await expect(bar(page).getByRole('button')).toHaveText([PRINT])
  })
  await stepAs('oaSupervisor', detail(id), async (page) => {
    await expect(head(page)).toContainText('已撤销')
    await expect(bar(page).getByRole('button')).toHaveText([PRINT])
  })
})

test('the supervisor approves, then withdraws before the director acts', async ({
  stepAs,
  request,
}) => {
  const id = await leaveRequest(request, 3, 'e2e-leave-withdraw')
  await stepAs('oaSupervisor', '/workflow/todo', async (page) => {
    await openTodo(page, id, SUPERVISOR)
    await act(page, 'approve', SUPERVISOR)
    await expect(bar(page).getByRole('button')).toHaveText([label('withdraw'), PRINT])
    await act(page, 'withdraw', SUPERVISOR)
    await expect(button(page, 'approve')).toBeVisible()
    await expect(button(page, 'withdraw')).toHaveCount(0)
  })
  // the director's task went with it
  await stepAs('oaDirector', detail(id), async (page) => {
    await expect(head(page)).toContainText('审批中')
    await expect(bar(page).getByRole('button')).toHaveText([PRINT])
  })
})

test('sent back to the employee: fewer days, resubmitted, in the supervisor to-dos again', async ({
  stepAs,
  request,
}) => {
  const REASON = 'e2e-leave-resubmit'
  const id = await leaveRequest(request, 3, REASON)
  await stepAs('oaSupervisor', '/workflow/todo', async (page) => {
    await openTodo(page, id, SUPERVISOR)
    await act(page, 'sendBack', SUPERVISOR, { choice: msg('wf.center.list.initiator') })
    await expect(bar(page).getByRole('button')).toHaveText([PRINT])
  })
  // the employee opens it from their to-dos: its detail sends them to the request's page to edit it
  // (3 days → 1) and resubmit, or cancels
  await stepAs('oaEmployee', '/workflow/todo', async (page) => {
    await openTodo(page, id, msg('seed.wf.node.begin'))
    const edit = msg('wf.center.decide.editResubmit')
    await expect(bar(page).getByRole('button')).toHaveText([edit, label('cancel'), PRINT])
    await bar(page).getByRole('button', { name: edit }).click()
    await expect(page).toHaveURL(/\/biz\/leave\/\d+$/)
    await expect(doc(page)).toContainText(REASON)
    await expect(page.getByText(msg('biz.leave.sentBack'))).toBeVisible()
    await page.getByRole('button', { name: msg('crud.action.edit') }).click()
    const dialog = page.getByRole('dialog', {
      name: msg('crud.title.edit', 'zh-CN', { name: msg('biz.leave.entity') }),
    })
    await dialog.getByRole('spinbutton', { name: msg('field.biz.leave.days') }).fill('1')
    await dialog.getByRole('button', { name: msg('crud.action.save') }).click()
    await expect(dialog).toBeHidden()
    await page.getByRole('button', { name: msg('biz.leave.resubmit') }).click()
    await page
      .getByRole('dialog', { name: msg('biz.leave.resubmit') })
      .getByRole('button', { name: msg('biz.leave.resubmit') })
      .click()
    await expect(page.getByText(msg('biz.leave.resubmitted'))).toBeVisible()
    await expect(page.getByText(msg('biz.leave.sentBack'))).toHaveCount(0)
  })
  // back in the supervisor's to-dos, on the edited days
  await stepAs('oaSupervisor', '/workflow/todo', async (page) => {
    await openTodo(page, id, SUPERVISOR)
    await expect(doc(page)).toContainText('1.0')
    await expect(button(page, 'approve')).toBeVisible()
  })
})

test('6 days: after the supervisor, HR and the director both hold it; approved once both approve', async ({
  stepAs,
  request,
}) => {
  const id = await leaveRequest(request, 6, 'e2e-leave-parallel')
  await stepAs('oaSupervisor', '/workflow/todo', async (page) => {
    await openTodo(page, id, SUPERVISOR)
    await act(page, 'approve', SUPERVISOR)
  })
  // both paths at once: HR has it, the director approves, HR still has it
  await stepAs('oaHr', '/workflow/todo', async (page) => {
    await openTodo(page, id, HR)
    await expect(button(page, 'approve')).toBeVisible()
  })
  await stepAs('oaDirector', '/workflow/todo', async (page) => {
    await openTodo(page, id, DIRECTOR)
    await act(page, 'approve', DIRECTOR)
    await expect(head(page)).toContainText('审批中')
  })
  await stepAs('oaHr', '/workflow/todo', async (page) => {
    await openTodo(page, id, HR)
    await act(page, 'approve', HR)
    await expect(head(page)).toContainText('已通过')
    await expect(doc(page)).toContainText('已通过')
  })
})
