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

// The decisions on the instance detail /workflow/instances/:id. The holder
// of a pending review task gets approve / reject / send back / transfer / delegate, each a dialog: send back
// chooses one of the task's back targets (steps already passed, then the initiator); transfer and delegate
// pick a user (UserPicker over every enabled user, by display name); the comment is required to approve,
// reject or add-sign after (an approval too) on a `commentRequired` step (the dialog's rule, nothing posted
// without one). A delegated task approves only, then it is back with its owner. The seeded process `leave`
// (3 days: supervisor → director) and a dynamic model with the admin as its reviewer.

const ALL = ['approve', 'reject', 'sendBack', 'transfer', 'delegate'] as const
type Decision = (typeof ALL)[number]
const label = (key: Decision) => msg(`wf.center.decide.${key}`)
const required = (field: string) =>
  msg('validation.required', 'zh-CN', { field: msg(`field.wf.task.${field}`) })

const bar = (page: Page) => page.locator('.wf-detail__actions')
const decision = (page: Page, key: Decision) =>
  bar(page).getByRole('button', { name: label(key), exact: true })
const head = (page: Page) => page.locator('.wf-detail > .el-card').first()
const timeline = (page: Page) => page.locator('.wf-timeline')

/** Opens the `key` dialog of the caller's task on step `node`. */
async function open(page: Page, key: Decision, node: string) {
  await decision(page, key).click()
  const dialog = page.getByRole('dialog', { name: `${label(key)} · ${node}` })
  await expect(dialog).toBeVisible()
  return dialog
}

/** Confirms dialog `key` (the rules pass); resolves with the body it posted. */
async function submit(page: Page, dialog: Locator, key: Decision) {
  const task = (r: { url(): string; request(): { method(): string } }) =>
    r.request().method() === 'POST' && /\/api\/wf\/tasks\/\d+\/[a-z-]+$/.test(r.url())
  const answered = page.waitForResponse(task)
  await dialog.getByRole('button', { name: label(key), exact: true }).click()
  const res = await answered
  expect(res.status(), await res.text()).toBe(200)
  await expect(dialog).toBeHidden()
  return res.request().postDataJSON() as unknown
}

/** Picks the user named `name` (display name) in the dialog's user field through UserPicker. */
async function pickUser(page: Page, dialog: Locator, name: string) {
  await dialog.getByRole('button', { name: msg('picker.user.title'), exact: true }).click()
  const picker = page.getByRole('dialog', { name: msg('picker.user.title') })
  await picker.getByRole('textbox', { name: msg('field.iam.user.keyword') }).fill(name)
  await picker.getByRole('row').filter({ hasText: name }).click()
  await picker.getByRole('button', { name: msg('picker.user.confirm'), exact: true }).click()
  await expect(picker).toBeHidden()
}

/** Counts the task actions `page` posts. */
function countPosts(page: Page) {
  const seen = { n: 0 }
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/api/wf/tasks/')) seen.n++
  })
  return seen
}

test('leave: supervisor approves → director sends it back to the supervisor step → supervisor rejects', async ({
  page,
  request,
}) => {
  const path = `/workflow/instances/${await leaveRequest(request, 3, 'e2e-center-decide-1')}`
  const posts = countPosts(page)
  const SUPERVISOR = msg('seed.wf.node.supervisor')
  const DIRECTOR = msg('seed.wf.node.director')

  await signIn(page, 'oaSupervisor', path)
  for (const key of ALL) await expect(decision(page, key)).toBeVisible()
  // this step takes an approval without a comment too; this one has one
  let dialog = await open(page, 'approve', SUPERVISOR)
  await dialog.getByRole('textbox', { name: msg('field.wf.task.comment') }).fill('e2e sup ok')
  expect(await submit(page, dialog, 'approve')).toEqual({ comment: 'e2e sup ok' })
  await expect(decision(page, 'approve')).toHaveCount(0)
  await expect(timeline(page)).toContainText('e2e sup ok')

  // the director: back to a step already passed or to the initiator, one must be chosen
  await signIn(page, 'oaDirector', path)
  dialog = await open(page, 'sendBack', DIRECTOR)
  await expect(dialog.locator('.el-radio')).toHaveText([
    SUPERVISOR,
    msg('wf.center.list.initiator'),
  ])
  const before = posts.n
  await dialog.getByRole('button', { name: label('sendBack'), exact: true }).click()
  await expect(dialog.getByText(required('to'))).toBeVisible()
  expect(posts.n).toBe(before)
  await dialog.locator('.el-radio').filter({ hasText: SUPERVISOR }).click()
  expect(await submit(page, dialog, 'sendBack')).toEqual({ to: 'supervisor' })
  await expect(bar(page).getByRole('button')).toHaveText([msg('wf.center.detail.print')])
  await expect(timeline(page).locator('.el-timeline-item').last()).toContainText(SUPERVISOR)

  // the supervisor holds the step again; a rejection ends the process (onReject finish)
  await signIn(page, 'oaSupervisor', path)
  dialog = await open(page, 'reject', SUPERVISOR)
  expect(await submit(page, dialog, 'reject')).toEqual({})
  await expect(head(page)).toContainText('已驳回')
  // the embedded leave request follows: its state is mirrored from the instance
  await expect(page.locator('.leave-view')).toContainText('已驳回')
  await expect(bar(page).getByRole('button')).toHaveText([msg('wf.center.detail.print')])
})

const CHECK = 'E2E check'

test('a step wanting a comment; transfer and delegate pick a user; the delegate approves only, then it is back', async ({
  page,
  request,
}) => {
  const root = { Authorization: await bearer(request) }
  const [admin, hr, deputy] = await Promise.all(
    ['admin', 'oa.hr', 'oa.deputy'].map((name) => userId(request, root, name)),
  )
  const modelKey = 'e2e-decide'
  await publishModel(
    request,
    root,
    { modelKey, name: 'E2E decide' },
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
        commentRequired: true,
      },
    },
  )
  // two initiators: a start is idempotent per user and body for 3 s
  const start = async (user: (typeof USERS)[keyof typeof USERS]) => {
    const res = await request.post('/api/wf/instances', {
      headers: { Authorization: await bearer(request, user) },
      data: { modelKey },
    })
    expect(res.status(), await res.text()).toBe(201)
    return ((await res.json()) as { data: { id: number } }).data.id
  }
  const [one, two] = [await start(USERS.staff), await start(USERS.oaEmployee)]
  const posts = countPosts(page)

  // approve and reject want a comment here: the rule, nothing posted
  await signIn(page, 'admin', `/workflow/instances/${one}`)
  for (const key of ['approve', 'reject'] as const) {
    const dialog = await open(page, key, CHECK)
    await dialog.getByRole('button', { name: label(key), exact: true }).click()
    await expect(dialog.getByText(required('comment'))).toBeVisible()
    await dialog.getByRole('button', { name: msg('common.action.cancel') }).click()
    await expect(dialog).toBeHidden()
  }
  // add-sign after approves now: it wants the comment too (add-sign before does not)
  const addSign = msg('wf.center.decide.addSign')
  await bar(page).getByRole('button', { name: addSign, exact: true }).click()
  const signDialog = page.getByRole('dialog', { name: `${addSign} · ${CHECK}` })
  await signDialog
    .locator('.el-radio')
    .filter({ hasText: msg('wf.center.decide.sign.after') })
    .click()
  await signDialog.getByRole('button', { name: addSign, exact: true }).click()
  await expect(signDialog.getByText(required('comment'))).toBeVisible()
  await signDialog
    .locator('.el-radio')
    .filter({ hasText: msg('wf.center.decide.sign.before') })
    .click()
  await expect(signDialog.getByText(required('comment'))).toHaveCount(0)
  await signDialog.getByRole('button', { name: msg('common.action.cancel') }).click()
  await expect(signDialog).toBeHidden()
  expect(posts.n).toBe(0)

  // transfer: somebody must be picked
  let dialog = await open(page, 'transfer', CHECK)
  await dialog.getByRole('button', { name: label('transfer'), exact: true }).click()
  await expect(dialog.getByText(required('userId'))).toBeVisible()
  expect(posts.n).toBe(0)
  await pickUser(page, dialog, 'OA HR')
  expect(await submit(page, dialog, 'transfer')).toEqual({ userId: hr })
  await expect(decision(page, 'approve')).toHaveCount(0)
  await expect(timeline(page)).toContainText('OA HR')

  // delegate: the deputy handles it first
  await page.goto(`/workflow/instances/${two}`)
  dialog = await open(page, 'delegate', CHECK)
  await expect(dialog).toContainText(msg('wf.center.decide.delegateHint'))
  await pickUser(page, dialog, 'OA Deputy')
  await dialog.getByRole('textbox', { name: msg('field.wf.task.comment') }).fill('e2e have a look')
  expect(await submit(page, dialog, 'delegate')).toEqual({
    userId: deputy,
    comment: 'e2e have a look',
  })
  await expect(decision(page, 'approve')).toHaveCount(0)

  // the deputy's task only approves, and the step still wants a comment
  await signIn(page, 'oaDeputy', `/workflow/instances/${two}`)
  await expect(decision(page, 'approve')).toBeVisible()
  for (const key of ALL.slice(1)) await expect(decision(page, key)).toHaveCount(0)
  dialog = await open(page, 'approve', CHECK)
  await dialog.getByRole('button', { name: label('approve'), exact: true }).click()
  await expect(dialog.getByText(required('comment'))).toBeVisible()
  await dialog.getByRole('textbox', { name: msg('field.wf.task.comment') }).fill('e2e looks fine')
  expect(await submit(page, dialog, 'approve')).toEqual({ comment: 'e2e looks fine' })
  await expect(decision(page, 'approve')).toHaveCount(0)

  // back with the admin to decide
  await signIn(page, 'admin', `/workflow/instances/${two}`)
  for (const key of ALL) await expect(decision(page, key)).toBeVisible()
  dialog = await open(page, 'approve', CHECK)
  await dialog.getByRole('textbox', { name: msg('field.wf.task.comment') }).fill('e2e approved')
  expect(await submit(page, dialog, 'approve')).toEqual({ comment: 'e2e approved' })
  await expect(head(page)).toContainText('已通过')
})
