// More 审批操作 on the H5 build over the workflow APIs (no mobile endpoints): add-sign (before holds my
// task, after approves it: a step wanting a comment wants one), remove-sign, cc and comment through the
// decision sheet; a delegated or add-sign task approves, copies and comments only; withdrawing my approval;
// the initiator's urge (once an hour: a second one says try again later) and cancel. Where no review task is
// mine, the bar holds these at hand. Process `leave` (supervisor → director) and the note model.
import { expect, test, type Page } from '@playwright/test'
import { bearer } from './env'
import {
  bar,
  comment,
  countPosts,
  DEPUTY,
  EMPLOYEE,
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

const field = (page: Page, name: string) => page.locator(`.qw-decide__${name}`)
const error = (page: Page, name: string) => field(page, name).locator('.qw-field__error')
const button = (page: Page, action: string) => page.locator(`.qw-decide-bar__${action}`)
const toast = (page: Page) => page.locator('.uni-simple-toast__text')

test('add-sign before and remove-sign; the signer comments and approves; cc', async ({
  page,
  request,
}) => {
  const id = await leave(request, await bearer(request, EMPLOYEE), 'm-wfext 1')
  const posts = countPosts(page)

  // the supervisor asks the deputy and HR first: users must be picked
  await openAs(page, SUPERVISOR, id)
  await open(page, 'addSign')
  await expect(page.locator('.qw-decide__title')).toHaveText('加签 · 主管审批')
  await expect(page.locator('.qw-decide__hint')).toHaveText(
    '他们全部通过后，任务回到你这里再做决定。',
  )
  await expect(field(page, 'kind').locator('.wd-radio')).toHaveText(['前加签', '后加签'])
  await expect(field(page, 'comment').locator('.qw-field__label')).not.toHaveClass(/is-required/)
  await submitButton(page).click()
  await expect(error(page, 'user')).toHaveText('人员至少 1 项')
  expect(posts.n).toBe(0)
  await pickUser(page, ['OA Deputy', 'OA HR'])
  await expect(error(page, 'user')).toHaveCount(0)
  expect(await submit(page)).toEqual({
    kind: 'before',
    userIds: [expect.any(Number), expect.any(Number)],
  })
  // my task waits for them: no decision, removing them at hand
  await expect(button(page, 'removeSign')).toBeVisible()
  await expect(button(page, 'approve')).toHaveCount(0)
  await expect(steps(page).last()).toContainText('→ OA Deputy, OA HR')

  // remove HR: one must be ticked
  await open(page, 'removeSign', true)
  await expect(page.locator('.qw-decide__title')).toHaveText('减签 · 主管审批')
  await expect(field(page, 'signs').locator('.wd-checkbox')).toHaveText(['OA Deputy', 'OA HR'])
  await submitButton(page).click()
  await expect(error(page, 'signs')).toHaveText('加签任务至少 1 项')
  expect(posts.n).toBe(1)
  await field(page, 'signs').locator('.wd-checkbox', { hasText: 'OA HR' }).click()
  expect(await submit(page)).toEqual({ taskIds: [expect.any(Number)] })
  await expect(steps(page).last()).toContainText('→ OA HR')
  await expect(button(page, 'removeSign')).toBeVisible()

  // the deputy's add-sign task: approve at hand, cc and comment under more; a comment wants its text
  await openAs(page, DEPUTY, id)
  await expect(button(page, 'reject')).toHaveCount(0)
  await button(page, 'more').click()
  await expect(page.locator('.wd-action-sheet__action')).toHaveText(['抄送', '评论'])
  await page.locator('.wd-action-sheet__action', { hasText: '评论' }).click()
  await expect(sheet(page)).toBeVisible()
  await expect(field(page, 'comment').locator('.qw-field__label')).toHaveClass(/is-required/)
  await submitButton(page).click()
  await expect(error(page, 'comment')).toHaveText('意见不能为空')
  expect(posts.n).toBe(2)
  await comment(page).fill('m sign note')
  expect(await submit(page)).toEqual({ comment: 'm sign note' })
  await expect(steps(page).last()).toContainText('m sign note')
  await open(page, 'approve')
  expect(await submit(page)).toEqual({})
  await expect(bar(page)).toHaveCount(0)

  // all signed: the supervisor decides again, and sends the director a copy with a note
  await openAs(page, SUPERVISOR, id)
  await expect(button(page, 'approve')).toBeVisible()
  await open(page, 'cc')
  await expect(page.locator('.qw-decide__title')).toHaveText('抄送 · 主管审批')
  await expect(field(page, 'comment').locator('.qw-field__label')).toHaveText('抄送说明')
  await pickUser(page, ['OA Director'])
  await comment(page).fill('m fyi')
  expect(await submit(page)).toEqual({ userIds: [expect.any(Number)], reason: 'm fyi' })
  await expect(steps(page).last()).toContainText('→ OA Director')
  await expect(steps(page).last()).toContainText('m fyi')
})

test('withdraw my approval; the initiator urges (again: try later) and cancels', async ({
  page,
  request,
}) => {
  const id = await leave(request, await bearer(request, EMPLOYEE), 'm-wfext 2')

  // the supervisor approves, then takes it back
  await openAs(page, SUPERVISOR, id)
  await open(page, 'approve')
  expect(await submit(page)).toEqual({})
  await expect(button(page, 'approve')).toHaveCount(0)
  await open(page, 'withdraw', true)
  await expect(page.locator('.qw-decide__title')).toHaveText('撤回 · 主管审批')
  await expect(page.locator('.qw-decide__hint')).toHaveText(
    '下一步还没有人处理时才能撤回，撤回后任务回到你这里。',
  )
  await comment(page).fill('m oops')
  expect(await submit(page)).toEqual({ comment: 'm oops' })
  await expect(button(page, 'approve')).toBeVisible()
  await expect(button(page, 'withdraw')).toHaveCount(0)
  await expect(steps(page).last()).toContainText('m oops')

  // the initiator: urge and cancel at hand; the urge button loads and is disabled while pending
  await openAs(page, EMPLOYEE, id)
  await expect(bar(page).locator('.wd-button')).toHaveText(['撤销', '催办'])
  const urges = { n: 0 }
  page.on('request', (r) => void (r.url().endsWith(`/api/wf/instances/${id}/urge`) && urges.n++))
  let release = () => {}
  const held = new Promise<void>((r) => (release = r))
  await page.route('**/api/wf/instances/*/urge', async (route) => {
    await held
    await route.continue()
  })
  await button(page, 'urge').click()
  await expect(button(page, 'urge')).toHaveClass(/is-loading/)
  await expect(button(page, 'urge')).toHaveClass(/is-disabled/)
  await button(page, 'urge').click({ force: true })
  release()
  await expect(toast(page)).toHaveText('已催办')
  await expect(steps(page).last()).toContainText('→ OA Supervisor')
  expect(urges.n).toBe(1)
  // once an hour: the server's 429 as "try again later"
  await expect(toast(page)).toBeHidden()
  const answered = page.waitForResponse((r) => r.url().endsWith('/urge'))
  await button(page, 'urge').click()
  expect((await answered).status()).toBe(429)
  await expect(toast(page)).toHaveText('每小时只能催办一次，请稍后再试')

  await open(page, 'cancel', true)
  await expect(page.locator('.qw-decide__title')).toHaveText('撤销')
  await expect(page.locator('.qw-decide__hint')).toHaveText('撤销后流程结束，不能恢复。')
  expect(await submit(page)).toEqual({})
  await expect(state(page)).toContainText('已撤销')
  await expect(bar(page)).toHaveCount(0)
})

test('add-sign after approves: a step wanting a comment wants one, of the signer too', async ({
  page,
  request,
}) => {
  const id = await startNote(request, await bearer(request, EMPLOYEE))
  const posts = countPosts(page)

  await openAs(page, SUPERVISOR, id)
  await open(page, 'addSign')
  await expect(page.locator('.qw-decide__title')).toHaveText(`加签 · ${NOTE_STEP}`)
  const label = field(page, 'comment').locator('.qw-field__label')
  await expect(label).not.toHaveClass(/is-required/)
  await field(page, 'kind').locator('.wd-radio', { hasText: '后加签' }).click()
  await expect(label).toHaveClass(/is-required/)
  await expect(page.locator('.qw-decide__hint')).toHaveText('你现在就通过，待他们全部通过后生效。')
  await pickUser(page, ['OA Deputy'])
  await submitButton(page).click()
  await expect(error(page, 'comment')).toHaveText('意见不能为空')
  // before approves nothing: the message goes
  await field(page, 'kind').locator('.wd-radio', { hasText: '前加签' }).click()
  await expect(error(page, 'comment')).toHaveCount(0)
  await field(page, 'kind').locator('.wd-radio', { hasText: '后加签' }).click()
  expect(posts.n).toBe(0)
  await comment(page).fill('m after ok')
  expect(await submit(page)).toEqual({
    kind: 'after',
    userIds: [expect.any(Number)],
    comment: 'm after ok',
  })
  await expect(button(page, 'removeSign')).toBeVisible()
  await expect(button(page, 'approve')).toHaveCount(0)

  // the signer's task is on the same step: its approval wants a comment too
  await openAs(page, DEPUTY, id)
  await open(page, 'approve')
  await submitButton(page).click()
  await expect(error(page, 'comment')).toHaveText('意见不能为空')
  expect(posts.n).toBe(1)
  await comment(page).fill('m deputy ok')
  expect(await submit(page)).toEqual({ comment: 'm deputy ok' })
  await expect(state(page)).toContainText('已通过')
})
