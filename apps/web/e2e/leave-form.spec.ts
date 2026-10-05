import type { APIRequestContext, Locator } from '@playwright/test'
import { bearer, currentPage, expect, msg, signIn, test, type Page } from './fixtures.ts'
import { USERS } from './env.ts'

// The OA leave pages over the seeded process `leave` and its seeded users.
// The employee opens the model's card on 发起申请 (its create_route /biz/leave/new), the shared zod rules
// check the form, the submit saves the request and starts the process, then the request's own page opens
// (/biz/leave/:id, the model's view_component): the request, its state and the approval timeline, nothing
// to do while the supervisor has it. Sent back to the employee (the supervisor's send-back through the API:
// its dialog is covered by the instance detail), the page offers edit and resubmit; the resubmitted request reaches the
// supervisor again and runs on the edited days (1 day: approved after the supervisor). The kept-alive list
// reloads when shown again and opens a request's page. en-US: step names and labels in English.

const REASON = 'e2e-leave-form-1'
const field = (prop: string) => msg(`field.biz.leave.${prop}`)
type Headers = Record<string, string>

/** Picks the dict entry `label` of the el-select labelled `name` inside `scope`. */
async function pick(page: Page, scope: Locator, name: string, label: string) {
  await scope.getByRole('combobox', { name }).click({ force: true })
  await page.getByRole('option', { name: label, exact: true }).click()
}

/** Types `text` into the date picker labelled `name` and closes it. */
async function date(page: Page, scope: Locator, name: string, text: string) {
  const input = scope.getByLabel(name, { exact: true })
  await input.fill(text)
  await input.press('Enter')
  await page.keyboard.press('Escape')
}

/** The supervisor's pending task on instance `instanceId` (their to-do through the API). */
async function supervisorTask(request: APIRequestContext, headers: Headers, instanceId: number) {
  const res = await request.get('/api/wf/tasks/todo', { headers, params: { pageSize: 100 } })
  const items = (
    (await res.json()) as { data: { items: { id: number; instance: { id: number } }[] } }
  ).data.items
  return items.filter((t) => t.instance.id === instanceId)
}

test('employee: start page → new request → its page; sent back → edit days → resubmit → supervisor again', async ({
  page,
  request,
}) => {
  // the list first (it stays kept alive), then the start page through the side menu
  await signIn(page, 'oaEmployee', '/biz/leave')
  await expect(currentPage(page, 'menu.biz.leave')).toBeVisible()
  const row = page.getByRole('row').filter({ hasText: REASON })
  await expect(row).toHaveCount(0)
  const menu = page.getByRole('navigation', { name: msg('common.layout.sideMenu') })
  await menu.getByRole('menuitem', { name: msg('menu.workflow.start') }).click()
  await expect(page).toHaveURL(/\/workflow\/start$/)
  // the card is named by the model's name and description (both seed.wf.* keys)
  const card = `${msg('seed.wf.leave')} ${msg('seed.wf.leaveDescription')}`
  await page.getByRole('button', { name: card, exact: true }).click()
  await expect(page).toHaveURL(/\/biz\/leave\/new$/)
  await expect(currentPage(page, 'menu.biz.leaveNew')).toBeVisible()

  // the shared rules first: nothing is posted
  const form = page.locator('.qw-form-card')
  const submit = form.getByRole('button', { name: msg('biz.leave.submit') })
  let posts = 0
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/api/biz/leaves')) posts++
  })
  await submit.click()
  await expect(
    form.getByText(msg('validation.required', 'zh-CN', { field: field('reason') })),
  ).toBeVisible()
  expect(posts).toBe(0)

  await pick(page, form, field('leaveKind'), '事假')
  await date(page, form, field('startAt'), '2026-10-12 09:00:00')
  await date(page, form, field('endAt'), '2026-10-14 18:00:00')
  await form.getByRole('spinbutton', { name: field('days') }).fill('3')
  await form.getByRole('textbox', { name: field('reason') }).fill(REASON)
  const answered = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/biz/leaves'),
  )
  await submit.click()
  const res = await answered
  expect(res.status()).toBe(201)
  const { id, instanceId } = ((await res.json()) as { data: { id: number; instanceId: number } })
    .data
  expect(posts).toBe(1)

  // the request's page: its fields and state, the approval panel with the timeline
  await expect(page).toHaveURL(new RegExp(`/biz/leave/${id}$`))
  await expect(currentPage(page, 'menu.biz.leaveView')).toBeVisible()
  await expect(currentPage(page, 'menu.biz.leaveNew')).toHaveCount(0)
  const request_ = page.locator('.el-descriptions')
  await expect(request_).toContainText('事假')
  await expect(request_).toContainText('3.0')
  await expect(request_).toContainText(REASON)
  await expect(request_).toContainText('2026-10-12 09:00')
  await expect(request_).toContainText('审批中')
  const timeline = page.locator('.wf-timeline')
  await expect(timeline.locator('.el-timeline-item')).toHaveCount(1)
  await expect(timeline).toContainText('OA Employee')
  await expect(timeline).toContainText(msg('seed.wf.node.begin'))
  const resubmit = page.getByRole('button', { name: msg('biz.leave.resubmit') })
  const edit = page.getByRole('button', { name: msg('crud.action.edit') })
  await expect(resubmit).toHaveCount(0)
  await expect(edit).toHaveCount(0)

  // the kept-alive list reloads when shown again; its row opens the request's page
  await page.getByRole('button', { name: msg('biz.leave.backToList') }).click()
  await expect(page).toHaveURL(/\/biz\/leave$/)
  await expect(currentPage(page, 'menu.biz.leaveView')).toHaveCount(0)
  await expect(row).toContainText('审批中')
  await row.getByRole('button', { name: msg('biz.leave.view') }).click()
  await expect(page).toHaveURL(new RegExp(`/biz/leave/${id}$`))
  await expect(request_).toContainText(REASON)

  // the supervisor sends it back to the employee
  const sup = { Authorization: await bearer(request, USERS.oaSupervisor) }
  const [task] = await supervisorTask(request, sup, instanceId)
  const back = await request.post(`/api/wf/tasks/${task!.id}/send-back`, {
    headers: sup,
    data: { to: 'begin', comment: 'e2e: fewer days' },
  })
  expect(back.ok(), await back.text()).toBe(true)

  await page.reload()
  await expect(page.getByText(msg('biz.leave.sentBack'))).toBeVisible()
  await expect(timeline).toContainText('OA Supervisor')
  await expect(timeline).toContainText(msg('seed.wf.node.supervisor'))
  await expect(timeline).toContainText('e2e: fewer days')

  // edit: 3 days → 1
  await edit.click()
  const dialog = page.getByRole('dialog', {
    name: msg('crud.title.edit', 'zh-CN', { name: msg('biz.leave.entity') }),
  })
  const days = dialog.getByRole('spinbutton', { name: field('days') })
  await expect(days).toHaveValue('3.0')
  await days.fill('1')
  await dialog.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(dialog).toBeHidden()
  await expect(request_).toContainText('1.0')

  // resubmit (confirmed): the page has nothing more to do, the supervisor has it again
  await resubmit.click()
  const confirm = page.getByRole('dialog', { name: msg('biz.leave.resubmit') })
  await confirm.getByRole('button', { name: msg('biz.leave.resubmit') }).click()
  await expect(page.getByText(msg('biz.leave.resubmitted'))).toBeVisible()
  await expect(resubmit).toHaveCount(0)
  await expect(page.getByText(msg('biz.leave.sentBack'))).toHaveCount(0)
  await expect(timeline.locator('.el-timeline-item')).toHaveCount(3)
  const [again] = await supervisorTask(request, sup, instanceId)
  expect(again).toBeTruthy()
  expect(again!.id).not.toBe(task!.id)

  // it runs on the edited days: 1 day ends after the supervisor
  const approved = await request.post(`/api/wf/tasks/${again!.id}/approve`, {
    headers: sup,
    data: {},
  })
  expect(approved.ok(), await approved.text()).toBe(true)
  await page.reload()
  await expect(request_).toContainText('已通过')

  // en-US: labels, step names and states in English
  await page.getByRole('button', { name: msg('common.layout.language') }).click()
  await page.getByRole('menuitem', { name: msg('common.language.enUS') }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US')
  await expect(page.getByText(msg('biz.leave.approval', 'en-US'))).toBeVisible()
  await expect(timeline).toContainText(msg('seed.wf.node.supervisor', 'en-US'))
  await expect(request_).toContainText('Approved')
})

test('the leave list: 新增 opens the new-request page', async ({ page }) => {
  await signIn(page, 'oaEmployee', '/biz/leave')
  await page.getByRole('button', { name: msg('crud.action.create'), exact: true }).click()
  await expect(page).toHaveURL(/\/biz\/leave\/new$/)
  await page.getByRole('button', { name: msg('biz.leave.backToList') }).click()
  await expect(page).toHaveURL(/\/biz\/leave$/)
  await expect(currentPage(page, 'menu.biz.leaveNew')).toHaveCount(0)
})
