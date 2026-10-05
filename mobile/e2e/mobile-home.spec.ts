// Main frame on the H5 build: the custom tab bar instead of the native one, the workbench's to-do, running
// and unread counts (also the approval / message tab badges) loaded when a tab page shows and every minute
// while no socket is connected (a fake clock; the socket blocked here, mobile-push covers the pushes), my
// newest to-dos, the shortcuts by permission opening their subpackage pages, a tab page without a session.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { HOME, USERS, badge, bearer, data, signIn, tab } from './env'
import { counts } from './wf'

/** the admin starts it, the SMS user reviews it: one more to-do and an assignment message each time */
const MODEL = { modelKey: 'mobile-e2e-home', name: 'Mobile e2e home' }

const start = async (request: APIRequestContext) =>
  data(
    request.post('/api/wf/instances', {
      headers: await bearer(request, USERS.admin),
      data: { modelKey: MODEL.modelKey },
    }),
  )

const value = (page: Page, name: string) => page.locator(`.qw-home__stat--${name} .qw-home__value`)
const shortcut = (page: Page, name: string) => page.locator(`.qw-home__shortcut--${name}`)
/** "Awaiting me": my newest to-dos */
const todos = (page: Page) => page.locator('.qw-home__todo')

test.beforeAll(async ({ request }) => {
  const admin = await bearer(request, USERS.admin)
  const users = await data<{ items: { id: number; username: string }[] }>(
    request.get('/api/iam/users', { headers: admin, params: { username: USERS.sms.username } }),
  )
  const reviewer = users.items.find((u) => u.username === USERS.sms.username)!.id
  const model = await data<{ id: number }>(
    request.post('/api/wf/models', {
      headers: admin,
      data: { formKind: 'dynamic', category: 'finance', ...MODEL },
    }),
  )
  const tree = {
    id: 'begin',
    type: 'begin',
    name: 'Begin',
    next: {
      id: 'check',
      type: 'review',
      name: 'Mobile check',
      assignee: { kind: 'users', ids: [reviewer] },
      sign: 'any',
      whenNobody: 'autoPass',
      whenInitiatorIsReviewer: 'self',
      onReject: 'finish',
    },
  }
  await data(
    request.post(`/api/wf/models/${model.id}/versions`, {
      headers: admin,
      data: { tree, fields: {} },
    }),
  )
})

test('workbench: counts on show and every minute, tab badges, shortcuts by permission', async ({
  page,
  request,
}) => {
  const sms = await bearer(request, USERS.sms)
  const before = await counts(request, sms)
  await start(request)
  // the assignment message is delivered in the background
  await expect.poll(async () => (await counts(request, sms)).unread).toBe(before.unread + 1)
  const now = await counts(request, sms)
  expect(now.todo).toBe(before.todo + 1)

  // the fallback: no socket, so only the minute's poll brings changes
  await page.routeWebSocket(/\/socket\.io\//, (ws) => ws.close())
  await page.clock.install()
  await page.goto('/')
  await signIn(page, USERS.sms)
  // the custom bar replaces the native one (it takes no runtime texts)
  await expect(page.locator('.qw-tabbar')).toBeVisible()
  await expect(page.locator('uni-tabbar')).toBeHidden()
  // labels in micro (22rpx) on a 16px line: App.vue's rule (wot-ui's scoped one misses our slot's label)
  const size = await page.evaluate<number>(
    "parseFloat(getComputedStyle(document.querySelector('.qw-tabbar .wd-tabbar-item__body-title')).fontSize)",
  )
  expect(size).toBeCloseTo((22 * page.viewportSize()!.width) / 750, 1)
  await expect(tab(page, '工作台').locator('.wd-tabbar-item__body-title')).toHaveCSS(
    'line-height',
    '16px',
  )
  await expect(page).toHaveTitle('工作台')
  await expect(page.locator('.qw-home__name')).toHaveText(`你好，${USERS.sms.username}`)
  await expect(value(page, 'todo')).toHaveText(String(now.todo))
  await expect(value(page, 'running')).toHaveText(String(now.running))
  await expect(value(page, 'unread')).toHaveText(String(now.unread))
  // the newest three to-dos: the model, who started it, the step
  await expect(todos(page)).toHaveCount(Math.min(3, now.todo))
  await expect(todos(page).first().locator('.qw-row__title')).toHaveText(MODEL.name)
  await expect(todos(page).first().locator('.qw-row__sub')).toContainText('发起 · Mobile check')
  await expect(badge(page, '审批')).toHaveText(String(now.todo))
  await expect(badge(page, '消息')).toHaveText(String(now.unread))
  // §12.8: read out with the tab's name (a visually hidden text; the visible label hidden from readers)
  await expect(tab(page, '审批').locator('.qw-sr-only')).toHaveText(`审批，${now.todo} 项待办`)
  await expect(tab(page, '审批').locator('.wd-tabbar-item__body-title')).toHaveAttribute(
    'aria-hidden',
    'true',
  )
  await expect(tab(page, '工作台').locator('.qw-sr-only')).toHaveCount(0)
  // sign-in-only shortcuts; a new leave request needs biz.leave.create (role demo has none)
  await expect(shortcut(page, 'start')).toBeVisible()
  await expect(shortcut(page, 'bulletin')).toBeVisible()
  await expect(shortcut(page, 'leave')).toHaveCount(0)

  // every minute while shown (and the socket down)
  await start(request)
  await expect.poll(async () => (await counts(request, sms)).unread).toBe(now.unread + 1)
  await expect(value(page, 'todo')).toHaveText(String(now.todo))
  await page.clock.fastForward(60_000)
  await expect(value(page, 'todo')).toHaveText(String(now.todo + 1))
  await expect(value(page, 'unread')).toHaveText(String(now.unread + 1))

  // when a tab page shows: another tab, then back
  await start(request)
  await expect.poll(async () => (await counts(request, sms)).unread).toBe(now.unread + 2)
  await tab(page, '审批').click()
  await expect(page).toHaveURL(/#\/pages\/approval\/index$/)
  await expect(page).toHaveTitle('审批')
  await expect(badge(page, '审批')).toHaveText(String(now.todo + 2))
  await expect(badge(page, '消息')).toHaveText(String(now.unread + 2))
  await tab(page, '工作台').click()
  await expect(page).toHaveURL(HOME)
  await expect(value(page, 'todo')).toHaveText(String(now.todo + 2))
  await expect(todos(page)).toHaveCount(Math.min(3, now.todo + 2))

  // a to-do opens its instance, "View all" the approval tab, a counter its tab, a shortcut its subpackage page
  await todos(page).first().click()
  await expect(page).toHaveURL(/#\/pages-wf\/detail\/index\?id=\d+$/)
  await page.goBack()
  await expect(page).toHaveURL(HOME)
  await page.locator('.qw-home__all').click()
  await expect(page).toHaveURL(/#\/pages\/approval\/index$/)
  await tab(page, '工作台').click()
  await page.locator('.qw-home__stat--unread').click()
  await expect(page).toHaveURL(/#\/pages\/message\/index$/)
  await tab(page, '工作台').click()
  await shortcut(page, 'start').click()
  await expect(page).toHaveURL(/#\/pages-wf\/start\/index$/)
  await expect(page).toHaveTitle('发起审批')
  await expect(page.locator('.qw-start__model').first()).toBeVisible()
})

test('root sees the permission-bound shortcut and its running processes; English tabs and titles', async ({
  page,
  request,
}) => {
  // the instances the first test started still wait for their reviewer
  const { running } = await counts(request, await bearer(request, USERS.admin))
  expect(running).toBeGreaterThan(0)
  await page.goto('/')
  await page.locator('.qw-login__lang').click()
  await page.locator('.wd-action-sheet__action', { hasText: 'English' }).click()
  await signIn(page, USERS.admin)
  await expect(page).toHaveTitle('Workbench')
  await expect(value(page, 'running')).toHaveText(String(running))
  await expect(page.locator('.qw-home__stat--running')).toContainText('In progress')
  await expect(page.locator('.qw-tabbar')).toContainText('Approvals')
  await expect(shortcut(page, 'leave')).toHaveText('Leave')
  await shortcut(page, 'leave').click()
  await expect(page).toHaveURL(/#\/pages-biz\/leave\/index$/)
  await expect(page).toHaveTitle('Leave')
})

test('a tab page without a session goes to sign-in', async ({ page }) => {
  await page.goto('/#/pages/message/index')
  await expect(page.locator('.qw-login__title')).toBeVisible()
})
