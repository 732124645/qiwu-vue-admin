// 审批操作 on the H5 build: the decisions on the approval detail over the task APIs (no
// mobile endpoints). The holder of a pending review task gets 通过 and 驳回 in the bottom bar and 退回 / 转办 /
// 委派 under 更多, each a bottom sheet: send back chooses one of the task's back targets (steps already
// passed, then the initiator); transfer and delegate pick a user (QwUserPicker over every enabled user); the
// comment is required to approve or reject on a `commentRequired` step (the shared rule: nothing posted
// without one); the submit button shows loading and is disabled while its request is pending. A
// delegated task only approves (of the decisions), then it is back with its owner. Process `leave` (3 days:
// supervisor → director) between the seeded OA users, and a dynamic model whose one step wants a comment.
import { expect, test } from '@playwright/test'
import { bearer } from './env'
import {
  bar,
  comment,
  countPosts,
  detailUrl,
  DEPUTY,
  DIRECTOR,
  EMPLOYEE,
  isActionPost,
  LABEL,
  leave,
  NOTE_STEP,
  open,
  openAs,
  pickUser,
  seedWf,
  sheet,
  startNote,
  state,
  steps,
  submit,
  submitButton,
  SUPERVISOR,
} from './wf'

test.beforeAll(seedWf)

test('leave: approve → send back to the supervisor step → transfer to the deputy → approved', async ({
  page,
  request,
}) => {
  const id = await leave(request, await bearer(request, EMPLOYEE), 'm-wfdec 1')
  const posts = countPosts(page)

  // the supervisor: approve with a comment
  await openAs(page, SUPERVISOR, id)
  await open(page, 'approve')
  await expect(page.locator('.qw-decide__title')).toHaveText('通过 · 主管审批')
  await comment(page).fill('m sup ok')
  expect(await submit(page)).toEqual({ comment: 'm sup ok' })
  // no decision left, only taking the approval back (withdraw)
  await expect(page.locator('.qw-decide-bar__withdraw')).toBeVisible()
  await expect(page.locator('.qw-decide-bar__approve')).toHaveCount(0)
  await expect(steps(page).last()).toContainText('m sup ok')

  // the director: back to a step already passed or to the initiator, one must be chosen
  await openAs(page, DIRECTOR, id)
  await open(page, 'sendBack')
  await expect(page.locator('.qw-decide__title')).toHaveText('退回 · 总监审批')
  await expect(page.locator('.qw-decide__to .wd-radio')).toHaveText(['主管审批', '发起人'])
  const before = posts.n
  await submitButton(page).click()
  await expect(page.locator('.qw-decide__to .qw-field__error')).toHaveText('退回节点不能为空')
  expect(posts.n).toBe(before)
  await page.locator('.qw-decide__to .wd-radio', { hasText: '主管审批' }).click()
  // once shown, the message follows the input
  await expect(page.locator('.qw-decide__to .qw-field__error')).toHaveCount(0)
  expect(await submit(page)).toEqual({ to: 'supervisor' })
  await expect(bar(page)).toHaveCount(0)
  await expect(steps(page).last()).toContainText('→ 主管审批')

  // the supervisor holds the step again: transfer, somebody must be picked
  await openAs(page, SUPERVISOR, id)
  await open(page, 'transfer')
  await submitButton(page).click()
  await expect(page.locator('.qw-decide__user .qw-field__error')).toHaveText('目标人员不能为空')
  expect(posts.n).toBe(before + 1)
  await pickUser(page, 'OA Deputy')
  await expect(page.locator('.qw-decide__user .qw-field__error')).toHaveCount(0)
  expect(await submit(page)).toEqual({ userId: expect.any(Number) })
  await expect(bar(page)).toHaveCount(0)
  await expect(steps(page).last()).toContainText('→ OA Deputy')

  // the deputy's is a task of their own now (all decisions); then the director
  await openAs(page, DEPUTY, id)
  await expect(page.locator('.qw-decide-bar__more')).toBeVisible()
  await open(page, 'approve')
  expect(await submit(page)).toEqual({})
  await openAs(page, DIRECTOR, id)
  await open(page, 'approve')
  expect(await submit(page)).toEqual({})
  await expect(state(page)).toContainText('已通过')
  await expect(bar(page)).toHaveCount(0)
})

test('leave: delegate (the delegate only approves, then it is back) and reject; send back to the initiator', async ({
  page,
  request,
}) => {
  const employee = await bearer(request, EMPLOYEE)
  const one = await leave(request, employee, 'm-wfdec 2')
  const two = await leave(request, employee, 'm-wfdec 3')

  await openAs(page, SUPERVISOR, one)
  await open(page, 'delegate')
  await expect(sheet(page)).toContainText('对方处理后，任务回到你这里再做决定。')
  await pickUser(page, 'OA Deputy')
  await comment(page).fill('please check')
  expect(await submit(page)).toEqual({ userId: expect.any(Number), comment: 'please check' })
  await expect(bar(page)).toHaveCount(0)

  // the delegate: approve only
  await openAs(page, DEPUTY, one)
  await expect(page.locator('.qw-decide-bar__approve')).toBeVisible()
  await expect(page.locator('.qw-decide-bar__reject')).toHaveCount(0)
  await open(page, 'approve')
  expect(await submit(page)).toEqual({})
  await expect(bar(page)).toHaveCount(0)

  // back with the supervisor, who decides: a rejection ends it (onReject finish)
  await openAs(page, SUPERVISOR, one)
  await expect(page.locator('.qw-decide-bar__more')).toBeVisible()
  await open(page, 'reject')
  expect(await submit(page)).toEqual({})
  await expect(state(page)).toContainText('已驳回')
  await expect(bar(page)).toHaveCount(0)

  // no step passed yet: only the initiator to send back to (a fresh load: the H5 router may take a
  // hash-only change to the page already open as going back to it)
  await page.goto('about:blank')
  await page.goto(detailUrl(two))
  await open(page, 'sendBack')
  await expect(page.locator('.qw-decide__to .wd-radio')).toHaveText(['发起人'])
  await page.locator('.qw-decide__to .wd-radio').click()
  expect(await submit(page)).toEqual({ to: 'begin' })
  await expect(steps(page).last()).toContainText('→ 发起人')
  await expect(bar(page)).toHaveCount(0)
  // the initiator's `begin` task is no decision (a resubmit); sent back, they may cancel
  await openAs(page, EMPLOYEE, two)
  await expect(state(page)).toContainText('审批中')
  await expect(page.locator('.qw-decide-bar__approve')).toHaveCount(0)
  await expect(page.locator('.qw-decide-bar__cancel')).toBeVisible()
})

test('a step wanting a comment: approve and reject need one; the button loads and is disabled while pending', async ({
  page,
  request,
}) => {
  const id = await startNote(request, await bearer(request, EMPLOYEE))
  const posts = countPosts(page)

  await openAs(page, SUPERVISOR, id)
  for (const key of ['approve', 'reject'] as const) {
    await open(page, key)
    await expect(page.locator('.qw-decide__title')).toHaveText(`${LABEL[key]} · ${NOTE_STEP}`)
    await expect(page.locator('.qw-decide__comment .qw-field__label')).toHaveClass(/is-required/)
    await submitButton(page).click()
    await expect(page.locator('.qw-decide__comment .qw-field__error')).toHaveText('意见不能为空')
    // closed by a tap on the overlay above it (below the navigation bar)
    await page.mouse.click(200, 150)
    await expect(sheet(page)).toBeHidden()
  }
  expect(posts.n).toBe(0)

  // held until released: the button shows loading and is disabled, a second tap posts nothing
  let release = () => {}
  const held = new Promise<void>((r) => (release = r))
  await page.route('**/api/wf/tasks/*/approve', async (route) => {
    await held
    await route.continue()
  })
  await open(page, 'approve')
  await comment(page).fill('m check ok')
  const answered = page.waitForResponse((r) => isActionPost(r.request()))
  await submitButton(page).click()
  await expect(submitButton(page)).toHaveClass(/is-loading/)
  await expect(submitButton(page)).toHaveClass(/is-disabled/)
  await submitButton(page).click({ force: true })
  release()
  expect((await answered).status()).toBe(200)
  await expect(state(page)).toContainText('已通过')
  expect(posts.n).toBe(1)
})
