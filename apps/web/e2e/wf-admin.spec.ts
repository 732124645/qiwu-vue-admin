import type { APIRequestContext, Locator } from '@playwright/test'
import { USERS } from './env.ts'
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

// 管理侧页面: 实例管理 (终止) and 任务管理 (改派) behind wfPerms, the rows as the server
// scopes them by the initiator's dept. Root sees every instance, terminates one (its open task is
// canceled) and reassigns a task to the staff user (it lands in their to-dos). e2e_wf_ops holds only the
// browse perms over its own dept (support): the support users' processes alone, no view / 终止 / 改派.
// e2e_wf_viewer holds browse + view but no approval center: 查看 opens the detail under 实例管理
// (/wf/instances/:id, the hidden page holding wf.instance.view). The staff user holds no wfPerms: no 流程管理
// group, the admin pages are 404.

const EN = 'en-US'
/** a seeded-key step name: the task page shows it through tx() */
const STEP = 'seed.position.engLead'
const COMMENT = 'Holder left the company'
/** dict labels (seeded in the database, not in the locale files) */
const RUNNING = '审批中'
const TERMINATED = '已终止'
const PENDING = '待处理'
const CANCELED = '已取消'

const begin = (next: object) => ({ id: 'begin', type: 'begin', name: 'Begin', next })
const review = (ids: number[]) => ({
  id: 'boss',
  type: 'review',
  name: STEP,
  assignee: { kind: 'users', ids },
  sign: 'any',
  whenNobody: 'autoPass',
  whenInitiatorIsReviewer: 'self',
  onReject: 'finish',
})

/** Starts `modelKey` as `user` (a session of its own: the duplicate-submit guard keys on it). */
async function start(request: APIRequestContext, user: keyof typeof USERS, modelKey: string) {
  const res = await request.post('/api/wf/instances', {
    headers: { Authorization: await bearer(request, USERS[user]) },
    data: { modelKey },
  })
  expect(res.status(), await res.text()).toBe(201)
  return ((await res.json()) as { data: { id: number } }).data.id
}

/** Model `modelKey` (one step root handles), started by root (dept hq) and by the staff user (support). */
async function setUp(request: APIRequestContext, modelKey: string) {
  const headers = { Authorization: await bearer(request) }
  const root = await userId(request, headers, USERS.admin.username)
  await publishModel(request, headers, { modelKey, name: `E2E ${modelKey}` }, begin(review([root])))
  return {
    ofRoot: await start(request, 'admin', modelKey),
    ofStaff: await start(request, 'staff', modelKey),
    staffId: await userId(request, headers, USERS.staff.username),
  }
}

const sideMenu = (page: Page) =>
  page.getByRole('navigation', { name: msg('common.layout.sideMenu') })
const rows = (page: Page) => page.locator('.el-table__body tr')

const modelKeyField = (page: Page) =>
  page.getByRole('textbox', { name: msg('field.wf.admin.modelKey') })
const instanceField = (page: Page) =>
  page.getByRole('spinbutton', { name: msg('field.wf.admin.instanceId') })

/** Fills `field` and searches; resolves once the list answered that search (`param` = `value`). */
async function search(page: Page, field: Locator, param: string, value: string) {
  await field.fill(value)
  const loaded = page.waitForResponse((r) => new URL(r.url()).searchParams.get(param) === value)
  await page.getByRole('button', { name: msg('crud.action.search'), exact: true }).click()
  await loaded
}

/** Opens 任务管理 from the side menu; resolves once it replaced the previous page (out-in transition). */
async function openTasks(page: Page) {
  await sideMenu(page)
    .getByRole('menuitem', { name: msg('menu.wf.task') })
    .click()
  await expect(currentPage(page, 'menu.wf.task')).toBeVisible()
  await expect(instanceField(page)).toBeVisible()
}

test('root: 终止 an instance, 改派 a task', async ({ page, request }) => {
  const modelKey = 'e2e-admin-root'
  const { ofRoot, ofStaff, staffId } = await setUp(request, modelKey)
  await signIn(page, 'admin', '/wf/instances')
  await expect(currentPage(page, 'menu.wf.instance')).toBeVisible()
  await search(page, modelKeyField(page), 'modelKey', modelKey)
  await expect(rows(page)).toHaveCount(2)
  const staffRow = rows(page).filter({ hasText: USERS.staff.username })
  for (const text of [String(ofStaff), msg('seed.dept.support'), RUNNING])
    await expect(staffRow).toContainText(text)
  await expect(staffRow.getByRole('button', { name: msg('wf.center.list.view') })).toBeVisible()

  // 终止 the staff user's instance with a comment: it ends, the action leaves the row
  await staffRow.getByRole('button', { name: msg('wf.admin.terminate.action') }).click()
  const dialog = page.getByRole('dialog', {
    name: msg('wf.admin.terminate.title', 'zh-CN', { id: ofStaff }),
  })
  await dialog.getByRole('textbox', { name: msg('field.wf.admin.comment') }).fill(COMMENT)
  const terminated = page.waitForRequest((r) =>
    r.url().endsWith(`/api/wf/instances/${ofStaff}/terminate`),
  )
  await dialog.getByRole('button', { name: msg('wf.admin.terminate.submit') }).click()
  expect((await terminated).postDataJSON()).toEqual({ comment: COMMENT })
  await expect(dialog).toBeHidden()
  await expect(staffRow).toContainText(TERMINATED)
  await expect(
    staffRow.getByRole('button', { name: msg('wf.admin.terminate.action') }),
  ).toHaveCount(0)
  await expect(rows(page).filter({ hasText: 'Administrator' })).toContainText(RUNNING)

  // 任务管理: the terminated instance's task was canceled (nothing to reassign)
  await openTasks(page)
  await search(page, instanceField(page), 'instanceId', String(ofStaff))
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page)).toContainText(CANCELED)
  await expect(rows(page).getByRole('button')).toHaveCount(0)

  // 改派 root's open task: the new assignee is required, then picked with the UserPicker
  await search(page, instanceField(page), 'instanceId', String(ofRoot))
  await expect(rows(page)).toHaveCount(1)
  for (const text of [msg(STEP), 'Administrator', PENDING])
    await expect(rows(page)).toContainText(text)
  await rows(page)
    .getByRole('button', { name: msg('wf.admin.reassign.action') })
    .click()
  const re = page.getByRole('dialog', {
    name: msg('wf.admin.reassign.title', 'zh-CN', { node: msg(STEP) }),
  })
  let posts = 0
  page.on('request', (r) => {
    if (r.url().endsWith('/reassign')) posts++
  })
  await re.getByRole('button', { name: msg('wf.admin.reassign.submit') }).click()
  await expect(
    re.getByText(msg('validation.required', 'zh-CN', { field: msg('field.wf.admin.to') })),
  ).toBeVisible()
  expect(posts).toBe(0)
  await re.getByRole('button', { name: msg('picker.user.title') }).click()
  const picker = page.getByRole('dialog', { name: msg('picker.user.title') })
  await picker
    .getByRole('textbox', { name: msg('field.iam.user.keyword') })
    .fill(USERS.staff.username)
  await picker.getByRole('row').filter({ hasText: USERS.staff.username }).click()
  await picker.getByRole('button', { name: msg('picker.user.confirm') }).click()
  await expect(picker).toBeHidden()
  const reassigned = page.waitForRequest((r) => /\/api\/wf\/tasks\/\d+\/reassign$/.test(r.url()))
  await re.getByRole('button', { name: msg('wf.admin.reassign.submit') }).click()
  expect((await reassigned).postDataJSON()).toEqual({ to: staffId, comment: null })
  await expect(re).toBeHidden()
  await expect(rows(page)).toContainText(USERS.staff.username)
  // the staff user holds it now
  const todo = await request.get('/api/wf/tasks/todo', {
    headers: { Authorization: await bearer(request, USERS.staff) },
  })
  const items = ((await todo.json()) as { data: { items: { instance: { id: number } }[] } }).data
    .items
  expect(items.map((t) => t.instance.id)).toContain(ofRoot)

  // en-US: step name and task state in English
  await page.getByRole('button', { name: msg('common.layout.language') }).click()
  await page.getByRole('menuitem', { name: msg('common.language.enUS') }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', EN)
  await expect(rows(page)).toContainText(msg(STEP, EN))
  await expect(rows(page)).toContainText('Pending')
  await expect(
    rows(page).getByRole('button', { name: msg('wf.admin.reassign.action', EN) }),
  ).toBeVisible()
})

test('a process admin with browse only: its own dept, no actions', async ({ page, request }) => {
  const modelKey = 'e2e-admin-scope'
  const { ofStaff } = await setUp(request, modelKey)
  await signIn(page, 'wfAdmin', '/wf/instances')
  await expect(currentPage(page, 'menu.wf.instance')).toBeVisible()
  const menu = sideMenu(page)
  await expect(menu.getByRole('menuitem', { name: msg('menu.wf.task') })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: msg('menu.wf.model') })).toHaveCount(0)

  // the server's scope (dept support): the staff user's process, not root's (dept hq)
  await search(page, modelKeyField(page), 'modelKey', modelKey)
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page)).toContainText(USERS.staff.username)
  await expect(rows(page)).toContainText(String(ofStaff))
  // no wf.instance.view, no wf.task.manage
  await expect(rows(page).getByRole('button')).toHaveCount(0)

  await openTasks(page)
  await search(page, modelKeyField(page), 'modelKey', modelKey)
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page)).toContainText(PENDING)
  await expect(rows(page).getByRole('button')).toHaveCount(0)
})

test('a process admin with view, no approval center: 查看 opens the instance detail', async ({
  page,
  request,
}) => {
  const modelKey = 'e2e-admin-view'
  const { ofStaff } = await setUp(request, modelKey)
  await signIn(page, 'wfViewer', '/wf/instances')
  await expect(currentPage(page, 'menu.wf.instance')).toBeVisible()
  await expect(
    sideMenu(page).getByRole('menuitem', { name: msg('menu.workflow.todo') }),
  ).toHaveCount(0)
  await search(page, modelKeyField(page), 'modelKey', modelKey)
  await expect(rows(page)).toHaveCount(1)
  await rows(page)
    .getByRole('button', { name: msg('wf.center.list.view') })
    .click()
  await expect(page).toHaveURL(new RegExp(`/wf/instances/${ofStaff}$`))
  await expect(currentPage(page, 'menu.workflow.detail')).toBeVisible()
  await expect(page.locator('.wf-detail > .el-card').first()).toContainText(
    `E2E ${modelKey}-${USERS.staff.username}-`,
  )
  await expect(page.locator('.wf-timeline')).toContainText(USERS.staff.username)
  await expect(page.getByText(msg('common.error.notFound'))).toHaveCount(0)
})

test('staff (no wfPerms): no 流程管理 group, the admin pages are 404', async ({ page }) => {
  await signIn(page, 'staff')
  await expect(page).toHaveURL(/\/home$/)
  const menu = sideMenu(page)
  await expect(menu.getByText(msg('menu.workflow.title'), { exact: true })).toBeVisible()
  await expect(menu.getByText(msg('menu.wf.title'), { exact: true })).toHaveCount(0)
  for (const path of ['/wf/instances', '/wf/tasks']) {
    await page.goto(path)
    await expect(page.getByText(msg('common.error.notFound'))).toBeVisible()
  }
})
