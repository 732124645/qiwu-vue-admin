// 发起 on the H5 build, over the workflow APIs (no mobile endpoints). The start page lists the models
// the caller may start by category (dict wf.category order), names through tx(); a custom-form model opens its
// mobile create page (the view registry), a dynamic one starts in a sheet asking the users of its
// initiatorPicks steps (each at least one). The leave form (shared leaveCreate rules, the submit loading and
// disabled while pending) starts process `leave`. The acceptance: the employee's 3-day leave on the phone →
// the supervisor approves → the director sends it back to the supervisor → who transfers it to the deputy →
// the deputy approves → the director approves → the employee sees it approved; a start then cancelled; sent
// back to the employee, who changes the days on the edit page and resubmits; en-US names.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { bearer, clientIp, serverScript, signIn, type User } from './env'
import {
  DEPUTY,
  DIRECTOR,
  EMPLOYEE,
  SUPERVISOR,
  bar,
  comment,
  leave,
  open,
  openAs,
  pickUser,
  seedWf,
  state,
  steps,
  submit,
} from './wf'

/** a dynamic model (category finance): a review step and a copy step whose users the initiator picks */
const PICKS = { key: 'm_wf_picks', name: 'M-wf expense', copy: 'M-wf copy' }
const SEED = `
import { compile } from '@qiwu/shared'
import { DataSource } from 'typeorm'
import { dataSourceOptions } from './dist/db/data-source.js'
import { insertRow } from './dist/db/seeds/upsert.js'
const { MODEL, NAME, COPY } = process.env
const ds = await new DataSource(dataSourceOptions()).initialize()
try {
  await ds.transaction(async (q) => {
    if ((await q.query('SELECT id FROM wf_model WHERE model_key = ?', [MODEL])).length) return
    const r = compile({ id: 'begin', type: 'begin', name: 'Begin', next: {
      id: 'lead', type: 'review', name: 'seed.wf.node.supervisor', assignee: { kind: 'initiatorPicks' },
      sign: 'any', whenNobody: 'autoPass', whenInitiatorIsReviewer: 'self', onReject: 'finish',
      next: { id: 'copy', type: 'notify', name: COPY, assignee: { kind: 'initiatorPicks' } },
    } }, {})
    if (!r.ok) throw new Error(JSON.stringify(r))
    const model = await insertRow(q, 'wf_model', {
      model_key: MODEL, name: NAME, category: 'finance', form_kind: 'dynamic', draft_json: r.flow.root,
    })
    const version = await insertRow(q, 'wf_version', {
      model_id: model, model_key: MODEL, version: 1, tree_json: r.flow.root, form_snapshot: { fields: {} },
    })
    await q.query('UPDATE wf_model SET current_version_id = ? WHERE id = ?', [version, model])
  })
} finally {
  await ds.destroy()
}
`

test.beforeAll(() => {
  seedWf()
  serverScript(SEED, { MODEL: PICKS.key, NAME: PICKS.name, COPY: PICKS.copy })
})

const group = (page: Page, name: string) =>
  page.locator('.qw-start__group', { has: page.locator('.qw-start__category', { hasText: name }) })
const model = (scope: Page | Locator, name: string) =>
  scope.locator('.qw-start__model', { hasText: name })
const field = (page: Page, name: string) => page.locator(`.qw-leave-form__${name}`)
const formSubmit = (page: Page) => page.locator('.qw-leave-form__submit')

/** `user` signs in on a fresh app (another language: switched first) and opens the start page. */
async function startPage(page: Page, user: User, english = false) {
  if (page.url().startsWith('http')) await page.evaluate(() => localStorage.clear())
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': clientIp() })
  await page.goto('about:blank')
  await page.goto('/')
  if (english) {
    await page.locator('.qw-login__lang').click()
    await page.locator('.wd-action-sheet__action', { hasText: 'English' }).click()
  }
  await signIn(page, user)
  await page.locator('.qw-home__shortcut--start').click()
  await expect(page).toHaveURL(/#\/pages-wf\/start\/index$/)
  await expect(page.locator('.qw-start__model').first()).toBeVisible()
}

/** Fills the leave form: `kind`, start and end as their pickers offer them (now), `days`, `reason`. */
async function fillLeave(page: Page, days: string, reason: string, kind = '事假') {
  await field(page, 'leaveKind').locator('.wd-cell').click()
  await page.locator('.wd-select-picker__radio-item', { hasText: kind }).click()
  await expect(field(page, 'leaveKind')).toContainText(kind)
  for (const time of ['startAt', 'endAt']) {
    await field(page, time).locator('.wd-cell').click()
    await page.locator('.wd-datetime-picker__action').last().click()
    await expect(field(page, time).locator('.wd-cell__value')).toHaveText(
      /^\d{4}-\d\d-\d\d \d\d:\d\d$/,
    )
  }
  await field(page, 'days').locator('input').fill(days)
  await field(page, 'days').locator('input').blur()
  await field(page, 'reason').locator('textarea').fill(reason)
}

/** Submits the new leave form; resolves with its instance, whose detail opened. */
async function submitLeave(page: Page) {
  const answered = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/biz/leaves'),
  )
  await formSubmit(page).click()
  const res = await answered
  expect(res.status(), await res.text()).toBe(201)
  const { instanceId } = ((await res.json()) as { data: { instanceId: number } }).data
  await expect(page).toHaveURL(new RegExp(`#/pages-wf/detail/index\\?id=${instanceId}$`))
  await expect(state(page)).toContainText('审批中')
  return instanceId
}

test('the start page: by category, a dynamic model starts with the picked users, a custom one opens its form', async ({
  page,
}) => {
  await startPage(page, EMPLOYEE)
  await expect(page).toHaveTitle('发起审批')
  // dict order (hr before finance); seeded names through tx()
  const categories = await page.locator('.qw-start__category').allTextContents()
  expect(categories.indexOf('人事')).toBeGreaterThanOrEqual(0)
  expect(categories.indexOf('人事')).toBeLessThan(categories.indexOf('财务'))
  await expect(model(group(page, '人事'), '请假审批')).toBeVisible()
  await expect(model(group(page, '财务'), PICKS.name)).toBeVisible()

  // a dynamic model: each initiatorPicks step (name through tx(), its kind) needs somebody
  await model(page, PICKS.name).click()
  const sheet = page.locator('.qw-start')
  await expect(sheet.locator('.qw-decide__title')).toHaveText(PICKS.name)
  const pick = sheet.locator('.qw-start__pick')
  await expect(pick.locator('.wd-cell__title')).toHaveText([
    '主管审批 · 审批人',
    `${PICKS.copy} · 抄送人`,
  ])
  let starts = 0
  page.on('request', (r) => void (r.url().endsWith('/api/wf/instances') && starts++))
  await sheet.locator('.qw-start__submit').click()
  await expect(pick.locator('.qw-field__error')).toHaveText([
    '请选择节点 主管审批 的人员',
    `请选择节点 ${PICKS.copy} 的人员`,
  ])
  expect(starts).toBe(0)
  // QwUserPicker over every enabled user, several each; once shown, the messages follow the picks
  // (each picker has its sheet)
  const picker = page.locator('.qw-user-picker__sheet').filter({ visible: true })
  for (const [i, name] of ['OA Deputy', 'OA Director'].entries()) {
    await pick.nth(i).locator('.wd-cell').click()
    await expect(picker).toBeVisible()
    await picker.locator('.wd-search input').fill(name)
    await picker.locator('.qw-user-picker__user', { hasText: name }).click()
    await picker.locator('.qw-picker__head .wd-button').click()
    await expect(picker).toBeHidden()
    await expect(pick.nth(i)).toContainText(name)
    await expect(pick.nth(i).locator('.qw-field__error')).toHaveCount(0)
  }
  const posted = page.waitForResponse((r) => r.url().endsWith('/api/wf/instances'))
  await sheet.locator('.qw-start__submit').click()
  const res = await posted
  expect(res.status(), await res.text()).toBe(201)
  expect(res.request().postDataJSON()).toEqual({
    modelKey: PICKS.key,
    initiatorPicks: { lead: [expect.any(Number)], copy: [expect.any(Number)] },
  })
  // its detail: the picked reviewer holds the step
  const { id } = ((await res.json()) as { data: { id: number } }).data
  await expect(page).toHaveURL(new RegExp(`#/pages-wf/detail/index\\?id=${id}$`))
  await expect(page.locator('.qw-wf__title')).toContainText(PICKS.name)
  await expect(state(page)).toContainText('审批中')
  await openAs(page, DEPUTY, id)
  await expect(page.locator('.qw-decide-bar__approve')).toBeVisible()

  // a custom model: its mobile create page
  await startPage(page, EMPLOYEE)
  await model(page, '请假审批').click()
  await expect(page).toHaveURL(/#\/pages-biz\/leave\/index$/)
  await expect(page).toHaveTitle('请假')
})

test('acceptance: a 3-day leave on the phone → approve → back to the supervisor → transfer → approved, the employee sees it', async ({
  page,
}) => {
  test.slow()
  await startPage(page, EMPLOYEE)
  await model(page, '请假审批').click()

  // the shared rules: nothing is posted until they pass
  let posts = 0
  page.on(
    'request',
    (r) => void (r.method() === 'POST' && r.url().endsWith('/api/biz/leaves') && posts++),
  )
  await formSubmit(page).click()
  for (const [name, message] of [
    ['leaveKind', '请假类型不能为空'],
    ['days', '请假天数不能为空'],
    ['reason', '请假事由不能为空'],
  ])
    await expect(field(page, name).locator('.qw-field__error')).toHaveText(message!)
  expect(posts).toBe(0)
  await fillLeave(page, '3', 'm-wfstart family matters')
  await expect(page.locator('.qw-leave-form .qw-field__error')).toHaveCount(0)

  // held until released: the button shows loading and is disabled, a second tap posts nothing
  let release = () => {}
  const held = new Promise<void>((r) => (release = r))
  await page.route('**/api/biz/leaves', async (route) => {
    await held
    await route.continue()
  })
  const id = submitLeave(page)
  await expect(formSubmit(page)).toHaveClass(/is-loading/)
  await expect(formSubmit(page)).toHaveClass(/is-disabled/)
  await formSubmit(page).click({ force: true })
  release()
  const instance = await id
  expect(posts).toBe(1)
  await page.unroute('**/api/biz/leaves')
  // the request: 3 days, through the director (over 2 days)
  await page.locator('.qw-wf__full').click()
  await expect(page.locator('.qw-leave')).toContainText('3.0')
  await expect(page.locator('.qw-leave')).toContainText('事假')

  await openAs(page, SUPERVISOR, instance)
  await open(page, 'approve')
  await comment(page).fill('m-wfstart ok')
  await submit(page)
  await openAs(page, DIRECTOR, instance)
  await open(page, 'sendBack')
  await page.locator('.qw-decide__to .wd-radio', { hasText: '主管审批' }).click()
  expect(await submit(page)).toEqual({ to: 'supervisor' })
  await openAs(page, SUPERVISOR, instance)
  await open(page, 'transfer')
  await pickUser(page, 'OA Deputy')
  await submit(page)
  await openAs(page, DEPUTY, instance)
  await open(page, 'approve')
  await submit(page)
  await openAs(page, DIRECTOR, instance)
  await open(page, 'approve')
  await submit(page)
  await expect(state(page)).toContainText('已通过')

  // the employee: approved in 我发起的 and on its detail
  await openAs(page, EMPLOYEE, instance)
  await page.goto('/#/pages/approval/index')
  await page.locator('.qw-seg__item', { hasText: '我发起的' }).click()
  const first = page.locator('.qw-approval__item').first()
  await expect(first).toContainText('已通过')
  await first.click()
  await expect(page).toHaveURL(new RegExp(`id=${instance}$`))
  await expect(state(page)).toContainText('已通过')
  // actor and action, the time, the step
  await expect(steps(page)).toContainText([
    /OA Employee发起.*发起人/,
    /OA Supervisor通过.*主管审批/,
    /OA Director退回.*总监审批/,
    /OA Supervisor转办.*主管审批/,
    /OA Deputy通过.*主管审批/,
    /OA Director通过.*总监审批/,
  ])
})

test('started, then cancelled by the employee', async ({ page }) => {
  await startPage(page, EMPLOYEE)
  await model(page, '请假审批').click()
  await fillLeave(page, '1', 'm-wfstart cancel me', '年假')
  await submitLeave(page)
  await open(page, 'cancel', true)
  await submit(page)
  await expect(state(page)).toContainText('已撤销')
  await expect(bar(page)).toHaveCount(0)
})

test('sent back to the employee: the days changed on the edit page, resubmitted, approved', async ({
  page,
  request,
}) => {
  test.slow()
  const id = await leave(request, await bearer(request, EMPLOYEE), 'm-wfstart send me back')
  await openAs(page, SUPERVISOR, id)
  await open(page, 'sendBack')
  await page.locator('.qw-decide__to .wd-radio', { hasText: '发起人' }).click()
  await submit(page)

  // the initiator: resubmit (and cancel) at hand; resubmit opens the request to change
  await openAs(page, EMPLOYEE, id)
  await expect(bar(page).locator('.wd-button')).toHaveText(['撤销', '重新提交'])
  await page.locator('.qw-decide-bar__resubmit').click()
  await expect(page).toHaveURL(/#\/pages-biz\/leave\/index\?id=\d+&task=\d+$/)
  await expect(page).toHaveTitle('修改请假')
  await expect(page.locator('.qw-leave-form__sentBack')).toBeVisible()
  await expect(field(page, 'leaveKind')).toContainText('事假')
  await expect(field(page, 'days').locator('input')).toHaveValue('3.0')
  await expect(field(page, 'reason').locator('textarea')).toHaveValue('m-wfstart send me back')

  // 2 days: saved, resubmitted, back on the reloaded detail
  await field(page, 'days').locator('input').fill('2')
  await field(page, 'days').locator('input').blur()
  const saved = page.waitForResponse((r) => r.request().method() === 'PUT')
  const resubmitted = page.waitForResponse((r) => r.url().endsWith('/resubmit'))
  await formSubmit(page).click()
  expect((await saved).request().postDataJSON()).toMatchObject({ days: 2 })
  expect((await resubmitted).status()).toBe(200)
  await expect(page).toHaveURL(new RegExp(`#/pages-wf/detail/index\\?id=${id}$`))
  await expect(steps(page).last()).toContainText('重新提交')
  await expect(page.locator('.qw-decide-bar__resubmit')).toHaveCount(0)
  await expect(state(page)).toContainText('审批中')

  // restarted at the supervisor; 2 days: done after them
  await openAs(page, SUPERVISOR, id)
  await open(page, 'approve')
  await submit(page)
  await expect(state(page)).toContainText('已通过')
  await page.locator('.qw-wf__full').click()
  await expect(page.locator('.qw-leave')).toContainText('2.0')
})

test('en-US: the start page, the dynamic sheet and the leave form in English', async ({ page }) => {
  await startPage(page, EMPLOYEE, true)
  await expect(page).toHaveTitle('New request')
  await expect(model(group(page, 'HR'), 'Leave approval')).toBeVisible()
  await expect(model(group(page, 'Finance'), PICKS.name)).toBeVisible()
  await model(page, PICKS.name).click()
  await expect(page.locator('.qw-start__pick .wd-cell__title')).toHaveText([
    "Supervisor approval · Approvers",
    `${PICKS.copy} · CC`,
  ])
  await expect(page.locator('.qw-start__submit')).toHaveText('Start')
  await page.mouse.click(200, 150)

  await model(page, 'Leave approval').click()
  await expect(page).toHaveTitle('Leave')
  for (const [name, label] of [
    ['leaveKind', 'Leave type'],
    ['startAt', 'Starts at'],
    ['days', 'Days'],
    ['reason', 'Reason'],
  ])
    await expect(field(page, name)).toContainText(label!)
  await expect(formSubmit(page)).toHaveText('Submit for approval')
})
