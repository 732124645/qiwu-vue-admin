import type { Locator } from '@playwright/test'
import { USERS } from './env.ts'
import {
  bearer,
  expect,
  leaveRequest,
  msg,
  publishModel,
  signIn,
  test,
  userId,
  type Page,
} from './fixtures.ts'

// The other actions on the instance detail /workflow/instances/:id, each a
// dialog. The holder of a pending review task adds signers (before: their task waits; after: approved now,
// in effect once they approved), copies users in (cc) and comments (a comment is required); an add-signer's
// task approves, copies and comments only. The caller's add-signs still pending are removed (remove-sign),
// their newest approval withdrawn while the next step has not acted. The initiator cancels and urges; a
// second urge within the hour (429) says to try again later. The seeded process `leave` (3 days: supervisor
// → director) and a dynamic model with the admin as its reviewer (UserPicker: every enabled user).

type Action = 'approve' | 'addSign' | 'removeSign' | 'cc' | 'comment' | 'withdraw' | 'cancel'
const label = (key: Action) => msg(`wf.center.decide.${key}`)
const URGE = msg('wf.center.urge.action')
const PRINT = msg('wf.center.detail.print')
const required = (field: string) =>
  msg('validation.required', 'zh-CN', { field: msg(`field.wf.task.${field}`) })
const atLeastOne = (field: string) =>
  msg('validation.too_small.array', 'zh-CN', { field: msg(`field.wf.task.${field}`), minimum: 1 })

const bar = (page: Page) => page.locator('.wf-detail__actions')
const action = (page: Page, key: Action) =>
  bar(page).getByRole('button', { name: label(key), exact: true })
const head = (page: Page) => page.locator('.wf-detail > .el-card').first()
const timeline = (page: Page) => page.locator('.wf-timeline')
const lastEvent = (page: Page) => timeline(page).locator('.el-timeline-item').last()

/** Opens the `key` dialog; `node`: the step in its title (cancel has none). */
async function open(page: Page, key: Action, node?: string) {
  await action(page, key).click()
  const dialog = page.getByRole('dialog', { name: node ? `${label(key)} · ${node}` : label(key) })
  await expect(dialog).toBeVisible()
  return dialog
}

/** POSTs of task and instance actions */
const isAction = (r: { url(): string; method(): string }) =>
  r.method() === 'POST' && /\/api\/wf\/(tasks|instances)\/\d+\/[a-z-]+$/.test(r.url())

/** Confirms dialog `key` (the rules pass); resolves with the path and body it posted. */
async function submit(page: Page, dialog: Locator, key: Action) {
  const answered = page.waitForResponse((r) => isAction(r.request()))
  await dialog.getByRole('button', { name: label(key), exact: true }).click()
  const res = await answered
  expect(res.status(), await res.text()).toBe(200)
  await expect(dialog).toBeHidden()
  return {
    path: new URL(res.url()).pathname,
    body: res.request().postDataJSON() as unknown,
  }
}

/** Clicks confirm in dialog `key` with a rule failing: `error` shows, nothing is posted. */
async function refused(page: Page, dialog: Locator, key: Action, error: string) {
  const posts = { n: 0 }
  const count = (r: { url(): string; method(): string }) => isAction(r) && posts.n++
  page.on('request', count)
  await dialog.getByRole('button', { name: label(key), exact: true }).click()
  await expect(dialog.getByText(error)).toBeVisible()
  page.off('request', count)
  expect(posts.n).toBe(0)
}

/**
 * Picks the users named `names` (display names, in this order) through the dialog's users field (WfUserIds →
 * UserPicker, multiple).
 */
async function pickUsers(page: Page, dialog: Locator, names: string[]) {
  await dialog.getByRole('button', { name: msg('wf.designer.assignee.pickUsers') }).click()
  const picker = page.getByRole('dialog', { name: msg('picker.user.title') })
  for (const name of names) {
    await picker.getByRole('textbox', { name: msg('field.iam.user.keyword') }).fill(name)
    await picker.getByRole('row').filter({ hasText: name }).click()
  }
  await picker.getByRole('button', { name: msg('picker.user.confirm'), exact: true }).click()
  await expect(picker).toBeHidden()
}

test('leave: the supervisor comments, approves and withdraws; the employee urges (again: later) and cancels', async ({
  page,
  request,
}) => {
  const id = await leaveRequest(request, 3, 'e2e-center-extra-1')
  const path = `/workflow/instances/${id}`
  const SUPERVISOR = msg('seed.wf.node.supervisor')

  // the initiator: cancel and urge, nothing to decide
  await signIn(page, 'oaEmployee', path)
  await expect(bar(page).getByRole('button')).toHaveText([label('cancel'), URGE, PRINT])
  const urged = page.waitForResponse((r) => r.url().endsWith(`/api/wf/instances/${id}/urge`))
  await bar(page).getByRole('button', { name: URGE }).click()
  expect((await urged).status()).toBe(200)
  await expect(page.getByText(msg('wf.center.urge.done'))).toBeVisible()
  await expect(lastEvent(page)).toContainText(URGE)
  // once an hour: the 429 says to try again later
  const again = page.waitForResponse((r) => r.url().endsWith(`/api/wf/instances/${id}/urge`))
  await bar(page).getByRole('button', { name: URGE }).click()
  expect((await again).status()).toBe(429)
  await expect(
    page.locator('.el-message--warning').filter({ hasText: msg('wf.center.urge.later') }),
  ).toBeVisible()
  // instead of the generic error toast of a 429 (shown before it: counted once, it fades out)
  expect(await page.locator('.el-message--error').count()).toBe(0)

  // the supervisor: a comment must say something; it decides nothing
  await signIn(page, 'oaSupervisor', path)
  for (const key of ['approve', 'addSign', 'cc', 'comment'] as const)
    await expect(action(page, key)).toBeVisible()
  await expect(action(page, 'withdraw')).toHaveCount(0)
  let dialog = await open(page, 'comment', SUPERVISOR)
  await refused(page, dialog, 'comment', required('comment'))
  await dialog.getByRole('textbox', { name: msg('field.wf.task.comment') }).fill('e2e a question')
  expect((await submit(page, dialog, 'comment')).body).toEqual({ comment: 'e2e a question' })
  await expect(lastEvent(page)).toContainText('e2e a question')
  await expect(action(page, 'approve')).toBeVisible()

  // approved, the step after it untouched: withdrawn, the task is the supervisor's again
  dialog = await open(page, 'approve', SUPERVISOR)
  await submit(page, dialog, 'approve')
  await expect(action(page, 'approve')).toHaveCount(0)
  dialog = await open(page, 'withdraw', SUPERVISOR)
  await expect(dialog).toContainText(msg('wf.center.decide.withdrawHint'))
  const withdrawn = await submit(page, dialog, 'withdraw')
  expect(withdrawn.path).toMatch(/^\/api\/wf\/tasks\/\d+\/withdraw$/)
  expect(withdrawn.body).toEqual({})
  await expect(action(page, 'approve')).toBeVisible()
  await expect(action(page, 'withdraw')).toHaveCount(0)
  // the director's task went with it
  await signIn(page, 'oaDirector', path)
  await expect(bar(page).getByRole('button')).toHaveText([PRINT])

  // the employee cancels: the process and the leave request end
  await signIn(page, 'oaEmployee', path)
  dialog = await open(page, 'cancel')
  await expect(dialog).toContainText(msg('wf.center.decide.cancelHint'))
  await dialog.getByRole('textbox', { name: msg('field.wf.task.comment') }).fill('e2e not needed')
  expect(await submit(page, dialog, 'cancel')).toEqual({
    path: `/api/wf/instances/${id}/cancel`,
    body: { comment: 'e2e not needed' },
  })
  await expect(head(page)).toContainText('已撤销')
  await expect(page.locator('.leave-view')).toContainText('已撤销')
  await expect(bar(page).getByRole('button')).toHaveText([PRINT])
})

const CHECK = 'E2E extra check'

test('add signers before and after, remove one, an add-signer approves only; cc with a reason', async ({
  page,
  request,
}) => {
  const root = { Authorization: await bearer(request) }
  const [hr, deputy] = await Promise.all(
    ['oa.hr', 'oa.deputy'].map((name) => userId(request, root, name)),
  )
  const admin = await userId(request, root, 'admin')
  const modelKey = 'e2e-extra'
  await publishModel(
    request,
    root,
    { modelKey, name: 'E2E extra' },
    {
      id: 'begin',
      type: 'begin',
      name: 'Begin',
      next: {
        id: 'check',
        type: 'review',
        name: CHECK,
        assignee: { kind: 'users', ids: [admin] },
        sign: 'any',
        whenNobody: 'autoPass',
        whenInitiatorIsReviewer: 'self',
        onReject: 'finish',
      },
    },
  )
  const started = await request.post('/api/wf/instances', {
    headers: { Authorization: await bearer(request, USERS.staff) },
    data: { modelKey },
  })
  expect(started.status(), await started.text()).toBe(201)
  const path = `/workflow/instances/${((await started.json()) as { data: { id: number } }).data.id}`

  // before: somebody must be picked; then the admin's task waits for them
  await signIn(page, 'admin', path)
  let dialog = await open(page, 'addSign', CHECK)
  await expect(dialog).toContainText(msg('wf.center.decide.signHint.before'))
  await refused(page, dialog, 'addSign', atLeastOne('userIds'))
  await pickUsers(page, dialog, ['OA HR', 'OA Deputy'])
  await expect(dialog.locator('.el-tag')).toHaveText(['OA HR', 'OA Deputy'])
  expect((await submit(page, dialog, 'addSign')).body).toEqual({
    kind: 'before',
    userIds: [hr, deputy],
  })
  await expect(action(page, 'approve')).toHaveCount(0)

  // remove-sign: one of the admin's signers still pending must be chosen
  dialog = await open(page, 'removeSign', CHECK)
  await expect(dialog.locator('.el-checkbox')).toHaveText(['OA HR', 'OA Deputy'])
  await refused(page, dialog, 'removeSign', atLeastOne('taskIds'))
  await dialog.locator('.el-checkbox').filter({ hasText: 'OA Deputy' }).click()
  const removed = await submit(page, dialog, 'removeSign')
  expect(removed.body).toEqual({ taskIds: [expect.any(Number)] })
  await expect(lastEvent(page)).toContainText('OA Deputy')
  await expect(action(page, 'removeSign')).toBeVisible() // the HR's is left

  // the HR's task (an add-sign) approves, copies and comments only
  await signIn(page, 'oaHr', path)
  await expect(bar(page).getByRole('button')).toHaveText([
    label('approve'),
    label('cc'),
    label('comment'),
    PRINT,
  ])
  dialog = await open(page, 'approve', CHECK)
  await submit(page, dialog, 'approve')

  // back with the admin: cc with a reason, then after-signers
  await signIn(page, 'admin', path)
  await expect(action(page, 'removeSign')).toHaveCount(0)
  dialog = await open(page, 'cc', CHECK)
  await refused(page, dialog, 'cc', atLeastOne('userIds'))
  await pickUsers(page, dialog, ['OA Deputy'])
  await dialog.getByRole('textbox', { name: msg('field.wf.task.reason') }).fill('e2e fyi')
  expect((await submit(page, dialog, 'cc')).body).toEqual({ userIds: [deputy], reason: 'e2e fyi' })
  await expect(lastEvent(page)).toContainText('OA Deputy')
  await expect(lastEvent(page)).toContainText('e2e fyi')

  dialog = await open(page, 'addSign', CHECK)
  await dialog
    .locator('.el-radio')
    .filter({ hasText: msg('wf.center.decide.sign.after') })
    .click()
  await expect(dialog).toContainText(msg('wf.center.decide.signHint.after'))
  await pickUsers(page, dialog, ['OA HR'])
  await dialog.getByRole('textbox', { name: msg('field.wf.task.comment') }).fill('e2e ok, hr next')
  expect((await submit(page, dialog, 'addSign')).body).toEqual({
    kind: 'after',
    userIds: [hr],
    comment: 'e2e ok, hr next',
  })
  // approved already: withdraw it or take the signer off again
  await expect(action(page, 'approve')).toHaveCount(0)
  await expect(action(page, 'withdraw')).toBeVisible()
  await expect(action(page, 'removeSign')).toBeVisible()

  await signIn(page, 'oaHr', path)
  dialog = await open(page, 'approve', CHECK)
  await submit(page, dialog, 'approve')
  await expect(head(page)).toContainText('已通过')
})
