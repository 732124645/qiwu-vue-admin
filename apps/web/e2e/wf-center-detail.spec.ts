import { USERS } from './env.ts'
import { bearer, currentPage, expect, msg, publishModel, signIn, test, userId } from './fixtures.ts'

// The instance detail /workflow/instances/:id. The supervisor opens the
// employee's leave request from 我的待办: the head (title, process, state), the request itself (model leave's
// view_component biz/leave/view, loaded read-only through the views glob) and the timeline. Print: the
// button calls window.print(); under the print medium only the document and the timeline are left (no side
// menu, header, tags, action bar or progress tree), and a dark theme prints light. The page reloads on a
// language switch (the server builds the title in the reader's language). Somebody the instance is not
// shown to: 404. Sent
// back to its initiator, a dynamic form is resubmitted from its detail (opened from 我的待办). The
// progress tree, the read-only designer with each step as the instance stands there (both paths of a
// parallel fork active at once, the path an exclusive fork did not take skipped).

const REASON = 'e2e-center-detail-1'
const EN = 'en-US'

test('supervisor: to-do → the leave request, its days and kind, the timeline; print keeps those two', async ({
  page,
  request,
}) => {
  // the employee submits a 3-day personal leave: process leave starts, the supervisor gets the to-do
  const res = await request.post('/api/biz/leaves', {
    headers: { Authorization: await bearer(request, USERS.oaEmployee) },
    data: {
      leaveKind: 'personal',
      startAt: '2026-11-02T09:00:00+08:00',
      endAt: '2026-11-04T18:00:00+08:00',
      days: 3,
      reason: REASON,
    },
  })
  expect(res.status(), await res.text()).toBe(201)
  const { instanceId } = ((await res.json()) as { data: { instanceId: number } }).data

  // newest to-do first: ours
  await signIn(page, 'oaSupervisor', '/workflow/todo')
  const title = `${msg('seed.wf.leave')}-OA Employee-`
  const row = page.locator('.el-table__body tr').filter({ hasText: title }).first()
  await row.getByRole('button', { name: msg('wf.center.list.handle') }).click()
  await expect(page).toHaveURL(new RegExp(`/workflow/instances/${instanceId}$`))
  await expect(currentPage(page, 'menu.workflow.detail')).toBeVisible()

  const head = page.locator('.wf-detail > .el-card').first()
  await expect(head).toContainText(title)
  await expect(head).toContainText('审批中')
  await expect(head).toContainText('OA Employee')
  // the request, read-only: days and kind, no edit or resubmit
  const doc = page.locator('.leave-view')
  await expect(doc).toContainText('事假')
  await expect(doc).toContainText('3.0')
  await expect(doc).toContainText(REASON)
  await expect(doc.getByRole('button')).toHaveCount(0)
  const timeline = page.locator('.wf-timeline')
  const progress = page.locator('.wf-detail__progress')
  await expect(progress.locator('[data-node-id="begin"]')).toHaveAttribute('data-progress', 'done')
  await expect(timeline.locator('.el-timeline-item')).toHaveCount(1)
  await expect(timeline).toContainText('OA Employee')
  await expect(timeline).toContainText(msg('seed.wf.node.begin'))

  // print: the button calls window.print()
  const print = page.getByRole('button', { name: msg('wf.center.detail.print') })
  await page.evaluate('window.print = () => { window.printed = (window.printed ?? 0) + 1 }')
  await print.click()
  expect(await page.evaluate('window.printed')).toBe(1)

  // the print medium: the document and the timeline, no navigation or actions
  await page.emulateMedia({ media: 'print' })
  await expect(page.getByRole('navigation', { name: msg('common.layout.sideMenu') })).toBeHidden()
  await expect(page.getByRole('navigation', { name: msg('common.tags.label') })).toBeHidden()
  await expect(page.getByRole('button', { name: msg('common.layout.language') })).toBeHidden()
  await expect(print).toBeHidden()
  await expect(doc).toBeVisible()
  await expect(timeline).toBeVisible()
  await expect(head).toBeVisible()
  await expect(progress).toBeHidden()
  await page.emulateMedia({ media: 'screen' })
  await expect(progress).toBeVisible()
  await expect(print).toBeVisible()

  // a dark theme prints light, then comes back
  const dark = () => page.evaluate(`document.documentElement.classList.contains('dark')`)
  await page.evaluate(`document.documentElement.classList.add('dark')`)
  await page.evaluate(`window.dispatchEvent(new Event('beforeprint'))`)
  expect(await dark()).toBe(false)
  await page.evaluate(`window.dispatchEvent(new Event('afterprint'))`)
  expect(await dark()).toBe(true)
  await page.evaluate(`document.documentElement.classList.remove('dark')`)

  // en-US: the page reloads, the title, step and kind in English
  await page.getByRole('button', { name: msg('common.layout.language') }).click()
  await page.getByRole('menuitem', { name: msg('common.language.enUS') }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', EN)
  await expect(head).toContainText(`${msg('seed.wf.leave', EN)}-OA Employee-`)
  await expect(head).toContainText('In progress')
  await expect(doc).toContainText('Personal leave')
  await expect(doc.locator('.el-descriptions__title')).toHaveText('Leave request')
  await expect(timeline).toContainText(msg('seed.wf.node.begin', EN))
  await expect(page.getByText(msg('wf.center.detail.timeline', EN))).toBeVisible()
})

test('an instance the caller may not see: 404, nothing shown', async ({ page, request }) => {
  const res = await request.post('/api/biz/leaves', {
    headers: { Authorization: await bearer(request, USERS.oaEmployee) },
    data: {
      leaveKind: 'annual',
      startAt: '2026-11-09T09:00:00+08:00',
      endAt: '2026-11-09T18:00:00+08:00',
      days: 1,
      reason: 'e2e-center-detail-2',
    },
  })
  expect(res.status(), await res.text()).toBe(201)
  const { instanceId } = ((await res.json()) as { data: { instanceId: number } }).data
  await signIn(page, 'staff', `/workflow/instances/${instanceId}`)
  await expect(page.locator('.el-message--error')).toBeVisible()
  await expect(page.locator('.wf-timeline')).toHaveCount(0)
  await expect(page.getByRole('button', { name: msg('wf.center.detail.print') })).toHaveCount(0)
})

test('sent back to its initiator: resubmitted from 我的待办 (a dynamic form)', async ({
  page,
  request,
}) => {
  const root = { Authorization: await bearer(request) }
  const admin = await userId(request, root, USERS.admin.username)
  const modelKey = 'e2e-detail-resubmit'
  const name = 'E2E resubmit'
  await publishModel(
    request,
    root,
    { modelKey, name },
    {
      id: 'begin',
      type: 'begin',
      name: 'Begin',
      next: {
        id: 'check',
        type: 'review',
        name: 'E2E resubmit check',
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
  const id = ((await started.json()) as { data: { id: number } }).data.id
  // root sends it back to the initiator
  const pendingOf = async () =>
    (
      (await (await request.get(`/api/wf/instances/${id}`, { headers: root })).json()) as {
        data: { myTasks: { id: number; type: string }[] }
      }
    ).data.myTasks
  const [review] = await pendingOf()
  const back = await request.post(`/api/wf/tasks/${review!.id}/send-back`, {
    headers: root,
    data: { to: 'begin' },
  })
  expect(back.ok(), await back.text()).toBe(true)

  await signIn(page, 'staff', '/workflow/todo')
  const row = page
    .locator('.el-table__body tr')
    .filter({ hasText: `${name}-` })
    .first()
  await row.getByRole('button', { name: msg('wf.center.list.handle') }).click()
  await expect(page).toHaveURL(new RegExp(`/workflow/instances/${id}$`))
  const bar = page.locator('.wf-detail__actions')
  const resubmit = msg('wf.center.decide.resubmit')
  await expect(bar.getByRole('button')).toHaveText([
    resubmit,
    msg('wf.center.decide.cancel'),
    msg('wf.center.detail.print'),
  ])
  await bar.getByRole('button', { name: resubmit }).click()
  const dialog = page.getByRole('dialog', { name: resubmit })
  await expect(dialog).toContainText(msg('wf.center.decide.resubmitHint'))
  const answered = page.waitForResponse((r) => r.url().endsWith('/resubmit'))
  await dialog.getByRole('button', { name: resubmit, exact: true }).click()
  expect((await answered).status()).toBe(200)
  await expect(dialog).toBeHidden()
  await expect(bar.getByRole('button', { name: resubmit })).toHaveCount(0)
  // the reviewer holds it again
  expect((await pendingOf()).map((t) => t.type)).toEqual(['review'])
})

test('the progress tree: steps by progress, both parallel paths active at once, the path not taken', async ({
  page,
  request,
}) => {
  const root = { Authorization: await bearer(request) }
  const admin = await userId(request, root, USERS.admin.username)
  const modelKey = 'e2e-detail-progress'
  const created = await request.post('/api/wf/models', {
    headers: root,
    data: { modelKey, name: 'E2E progress', formKind: 'dynamic', category: 'finance' },
  })
  expect(created.ok(), await created.text()).toBe(true)
  const model = ((await created.json()) as { data: { id: number } }).data.id
  const review = (id: string, next?: object) => ({
    id,
    type: 'review',
    name: `E2E ${id}`,
    assignee: { kind: 'users', ids: [admin] },
    sign: 'any',
    whenNobody: 'autoPass',
    whenInitiatorIsReviewer: 'self',
    onReject: 'finish',
    next,
  })
  const path = (id: string, child?: object, extra: object = {}) => ({
    id,
    name: `E2E ${id}`,
    when: [],
    child,
    ...extra,
  })
  // begin → first → route: amount > 1000 → finance / else (empty) → both: l ∥ r → last
  const tree = {
    id: 'begin',
    type: 'begin',
    name: 'Begin',
    next: review('first', {
      id: 'route',
      type: 'fork',
      name: 'Route',
      mode: 'exclusive',
      paths: [
        path('big', review('finance'), { when: [[{ field: 'amount', op: 'gt', value: 1000 }]] }),
        path('small', undefined, { fallback: true }),
      ],
      next: {
        id: 'both',
        type: 'fork',
        name: 'Both',
        mode: 'parallel',
        paths: [path('left', review('l')), path('right', review('r'))],
        next: review('last'),
      },
    }),
  }
  const version = await request.post(`/api/wf/models/${model}/versions`, {
    headers: root,
    data: { tree, fields: { amount: 'number' } },
  })
  expect(version.ok(), await version.text()).toBe(true)
  const started = await request.post('/api/wf/instances', {
    headers: { Authorization: await bearer(request, USERS.staff) },
    data: { modelKey, formValues: { amount: 5 } },
  })
  expect(started.status(), await started.text()).toBe(201)
  const id = ((await started.json()) as { data: { id: number } }).data.id
  /** root approves its oldest pending task on the instance */
  const approve = async () => {
    const res = await request.get(`/api/wf/instances/${id}`, { headers: root })
    const [task] = ((await res.json()) as { data: { myTasks: { id: number }[] } }).data.myTasks
    const done = await request.post(`/api/wf/tasks/${task!.id}/approve`, {
      headers: root,
      data: {},
    })
    expect(done.ok(), await done.text()).toBe(true)
  }
  await approve()

  await signIn(page, 'staff', `/workflow/instances/${id}`)
  const progress = page.locator('.wf-detail__progress')
  await expect(progress).toContainText(msg('wf.center.detail.progress'))
  // a tree model's instance: the progress tree, no BPMN diagram
  await expect(page.locator('.wf-detail__diagram, .wf-bpmn')).toHaveCount(0)
  const expectProgress = async (want: Record<string, string>) => {
    for (const [node, p] of Object.entries(want))
      await expect(progress.locator(`[data-node-id="${node}"]`)).toHaveAttribute('data-progress', p)
  }
  await expectProgress({
    begin: 'done',
    first: 'done',
    route: 'done',
    big: 'skipped',
    finance: 'skipped',
    small: 'done',
    both: 'active',
    left: 'done',
    l: 'active',
    right: 'done',
    r: 'active',
    last: 'pending',
  })
  // the fork and both its steps, named for screen readers; a legend; nothing to edit
  const active = msg('wf.designer.progress.active')
  await expect(progress.getByRole('img', { name: active })).toHaveCount(3)
  await expect(progress.locator('.wf-designer__legend li')).toHaveText([
    msg('wf.designer.progress.done'),
    active,
    msg('wf.designer.progress.pending'),
    msg('wf.designer.progress.skipped'),
  ])
  await expect(progress.getByRole('button')).toHaveCount(0)

  // one path done: the join waits for the other
  await approve()
  await page.reload()
  await expectProgress({ l: 'done', r: 'active', both: 'active', last: 'pending' })
  await expect(progress.getByRole('img', { name: active })).toHaveCount(2)
})
