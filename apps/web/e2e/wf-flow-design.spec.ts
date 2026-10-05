import type { APIRequestContext, Locator } from '@playwright/test'
import { USERS, type E2eUser } from './env.ts'
import { bearer, expect, kindsFit, msg, signIn, test, userId, type Page } from './fixtures.ts'

// Acceptance: a flow drawn in the designer 流程设计 — supervisor review → fork
// (amount > 1000 → finance review / fallback) → copy — published and run down both paths; a draft whose fork
// lost its fallback path refused on publish with the fork marked, fixed by a mode switch; a parallel fork
// (two reviews) published and started: both to-dos at once; a review set to hand an overdue to-do
// to the manager, published and reopened as set. A dynamic model without a bound form: its
// fields come from a v1 published through the API, instances start with form values through the API.

type Headers = Record<string, string>
const add = msg('wf.designer.add')

/** A dynamic finance model; v1 (just its begin node) published with `fields` unless null. Its id. */
async function newModel(
  request: APIRequestContext,
  headers: Headers,
  modelKey: string,
  fields: object | null,
) {
  const created = await request.post('/api/wf/models', {
    headers,
    data: { modelKey, name: modelKey, formKind: 'dynamic', category: 'finance' },
  })
  expect(created.ok(), await created.text()).toBe(true)
  const { id } = ((await created.json()) as { data: { id: number } }).data
  if (fields) {
    const v1 = await request.post(`/api/wf/models/${id}/versions`, {
      headers,
      data: { tree: { id: 'begin', type: 'begin', name: 'Begin' }, fields },
    })
    expect(v1.ok(), await v1.text()).toBe(true)
  }
  return id
}

/** The design page's designer, its drawer and the steps the tests take there. */
function designerOf(page: Page) {
  const designer = page.locator('.wf-designer')
  const drawer = page.locator('.wf-node-drawer')
  return {
    designer,
    drawer,
    /** adds a step of `type` through the "+" `plus` */
    async addStep(plus: Locator, type: 'review' | 'notify' | 'fork') {
      await plus.click()
      const item = page.getByRole('menuitem', { name: msg(`wf.designer.type.${type}`) })
      await item.click()
      // closed before the next "+" opens its own
      await expect(item).toBeHidden()
    },
    /** opens `card`, names it and (a review / notify) picks the user `username` */
    async configure(card: Locator, name: string, username?: E2eUser) {
      await card.locator('.wf-card__main').click()
      await drawer.getByRole('textbox', { name: msg('wf.designer.drawer.name') }).fill(name)
      if (username) {
        await drawer.getByRole('button', { name: msg('wf.designer.assignee.pickUsers') }).click()
        const picker = page.getByRole('dialog', { name: msg('picker.user.title') })
        const login = USERS[username].username
        await picker.getByRole('textbox', { name: msg('field.iam.user.keyword') }).fill(login)
        await picker.getByRole('row').filter({ hasText: login }).click()
        await picker.getByRole('button', { name: msg('picker.user.confirm') }).click()
        await expect(picker).toBeHidden()
      }
      await page.keyboard.press('Escape')
      await expect(drawer).toBeHidden()
    },
    /** publishes from the page; the posted tree */
    async publish(id: number) {
      const posted = page.waitForRequest(
        (r) => r.method() === 'POST' && r.url().endsWith(`/api/wf/models/${id}/versions`),
      )
      await page.getByRole('button', { name: msg('wf.model.design.publish') }).click()
      await page
        .getByRole('dialog', { name: msg('wf.model.design.confirmTitle') })
        .getByRole('button', { name: msg('wf.model.design.publish') })
        .click()
      return ((await posted).postDataJSON() as { tree: Tree }).tree
    },
  }
}

type Tree = { id: string; next?: Tree; paths?: { id: string; child?: Tree }[] }

/** headers of each user, signed in once */
const sessions = (request: APIRequestContext) => {
  const cache = new Map<E2eUser, Promise<string>>()
  return async (user: E2eUser): Promise<Headers> => {
    if (!cache.has(user)) cache.set(user, bearer(request, USERS[user]))
    return { Authorization: await cache.get(user)! }
  }
}

test('exclusive fork: drawn, published, run down both paths', async ({ page, request }) => {
  const as = sessions(request)
  const root = await as('admin')
  const modelKey = 'e2e-flow-exclusive'
  const id = await newModel(request, root, modelKey, { amount: 'number' })
  const [supervisor, director, hr] = await Promise.all(
    (['oaSupervisor', 'oaDirector', 'oaHr'] as const).map((u) =>
      userId(request, root, USERS[u].username),
    ),
  )

  await signIn(page, 'admin', `/wf/models/${id}/design`)
  const { designer, drawer, addStep, configure, publish } = designerOf(page)
  const plus = designer.getByRole('button', { name: add })
  // begin → supervisor → fork → copy (each "+" at the end)
  await addStep(plus.last(), 'review')
  await addStep(plus.last(), 'fork')
  await addStep(plus.last(), 'notify')
  await configure(designer.locator('.wf-card--review'), 'E2E Supervisor', 'oaSupervisor')
  await configure(designer.locator('.wf-card--notify'), 'E2E Copy', 'oaHr')

  // path 1: amount > 1000 → finance; path 2 is the fallback
  const paths = designer.locator('.wf-fork__path')
  await expect(paths).toHaveCount(2)
  await expect(paths.nth(1)).toContainText(msg('wf.designer.summary.fallback'))
  await paths.first().locator('.wf-card--path .wf-card__main').click()
  await drawer.getByRole('button', { name: msg('wf.designer.cond.addGroup') }).click()
  await drawer.getByRole('combobox', { name: msg('wf.designer.cond.op') }).click({ force: true })
  await page.getByRole('option', { name: msg('wf.designer.op.gt'), exact: true }).click()
  const value = drawer.getByRole('spinbutton', { name: msg('wf.designer.cond.value') })
  await value.fill('1000')
  await value.blur()
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  await expect(paths.first()).toContainText(`amount ${msg('wf.designer.op.gt')} 1000`)
  await addStep(paths.first().getByRole('button', { name: add }), 'review')
  await configure(paths.first().locator('.wf-card--review'), 'E2E Finance', 'oaDirector')

  const tree = await publish(id)
  await expect(
    page.getByText(msg('wf.model.design.published', 'zh-CN', { version: 2 })),
  ).toBeVisible()
  expect(tree).toMatchObject({
    next: {
      type: 'review',
      name: 'E2E Supervisor',
      assignee: { kind: 'users', ids: [supervisor] },
      next: {
        type: 'fork',
        mode: 'exclusive',
        paths: [
          {
            when: [[{ field: 'amount', op: 'gt', value: 1000 }]],
            child: { type: 'review', name: 'E2E Finance', assignee: { ids: [director] } },
          },
          { fallback: true, when: [] },
        ],
        next: { type: 'notify', name: 'E2E Copy', assignee: { ids: [hr] } },
      },
    },
  })
  const review = tree.next!
  const fork = review.next!
  const [big, other] = fork.paths!
  const finance = big!.child!
  const copy = fork.next!

  // the staff user starts it with an amount; each reviewer approves their pending step
  const staff = await as('staff')
  const start = async (amount: number) => {
    const res = await request.post('/api/wf/instances', {
      headers: staff,
      data: { modelKey, formValues: { amount } },
    })
    expect(res.status(), await res.text()).toBe(201)
    return ((await res.json()) as { data: { id: number } }).data.id
  }
  const detail = async (instance: number, user: E2eUser = 'staff') => {
    const res = await request.get(`/api/wf/instances/${instance}`, { headers: await as(user) })
    expect(res.ok(), await res.text()).toBe(true)
    return (
      (await res.json()) as {
        data: {
          state: string
          progress: Record<string, string>
          myTasks: { id: number; nodeId: string }[]
        }
      }
    ).data
  }
  const approve = async (instance: number, user: E2eUser, nodeId: string) => {
    const tasks = (await detail(instance, user)).myTasks
    expect(tasks.map((t) => t.nodeId)).toEqual([nodeId])
    const res = await request.post(`/api/wf/tasks/${tasks[0]!.id}/approve`, {
      headers: await as(user),
      data: {},
    })
    expect(res.ok(), await res.text()).toBe(true)
  }

  // 5000: supervisor, then finance, then the copy
  const large = await start(5000)
  await approve(large, 'oaSupervisor', review.id)
  await approve(large, 'oaDirector', finance.id)
  expect(await detail(large)).toMatchObject({
    state: 'approved',
    progress: {
      [review.id]: 'done',
      [fork.id]: 'done',
      [big!.id]: 'done',
      [finance.id]: 'done',
      [other!.id]: 'skipped',
      [copy.id]: 'done',
    },
  })

  // 500: the fallback path, no finance step
  const small = await start(500)
  await approve(small, 'oaSupervisor', review.id)
  expect(await detail(small)).toMatchObject({
    state: 'approved',
    progress: {
      [big!.id]: 'skipped',
      [finance.id]: 'skipped',
      [other!.id]: 'done',
      [copy.id]: 'done',
    },
  })

  // both copies reached HR
  const ccs = await request.get('/api/wf/ccs/mine', { headers: await as('oaHr') })
  const items = ((await ccs.json()) as { data: { items: { instance: { id: number } }[] } }).data
    .items
  expect(items.map((c) => c.instance.id)).toEqual(expect.arrayContaining([large, small]))
})

test('a fork without its fallback path: publish refused, the fork marked; a mode switch restores it', async ({
  page,
  request,
}) => {
  const root = { Authorization: await bearer(request) }
  const id = await newModel(request, root, 'e2e-flow-no-fallback', { amount: 'number' })
  // a draft saved as it is (checked only on publish): two conditional paths, none the fallback
  const when = (op: string) => [[{ field: 'amount', op, value: 1000 }]]
  const draft = await request.put(`/api/wf/models/${id}/draft`, {
    headers: root,
    data: {
      tree: {
        id: 'begin',
        type: 'begin',
        name: 'Begin',
        next: {
          id: 'amount',
          type: 'fork',
          name: 'Amount',
          mode: 'exclusive',
          paths: [
            { id: 'big', name: 'Big', when: when('gt') },
            { id: 'small', name: 'Small', when: when('lte') },
          ],
        },
      },
    },
  })
  expect(draft.ok(), await draft.text()).toBe(true)

  await signIn(page, 'admin', `/wf/models/${id}/design`)
  const { designer, publish } = designerOf(page)
  const fork = designer.locator('.wf-fork')
  await expect(fork.locator('.wf-card--path')).toHaveCount(2)
  const publishes: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith(`/api/wf/models/${id}/versions`))
      publishes.push(r.url())
  })
  await page.getByRole('button', { name: msg('wf.model.design.publish') }).click()
  const node = msg('wf.designer.check.quote', 'zh-CN', { name: 'Amount' })
  await expect(designer.getByRole('alert')).toContainText(
    msg('validation.wf.fallback_count', 'zh-CN', { node }),
  )
  await expect(fork).toHaveClass(/is-error/)
  await expect(designer.locator('.is-error')).toHaveCount(1)
  expect(publishes).toEqual([])

  // inclusive, then exclusive again: the last path becomes the fallback (its conditions dropped)
  const mode = (m: string) =>
    fork.locator('.el-radio-button').filter({ hasText: msg(`wf.designer.fork.modes.${m}`) })
  await mode('inclusive').click()
  await mode('exclusive').click()
  await expect(designer.getByRole('alert')).toHaveCount(0)
  await expect(designer.locator('.is-error')).toHaveCount(0)
  await expect(fork.locator('.wf-card--path').nth(1)).toContainText(
    msg('wf.designer.summary.fallback'),
  )
  expect(await publish(id)).toMatchObject({
    next: {
      mode: 'exclusive',
      paths: [
        { id: 'big', when: when('gt') },
        { id: 'small', fallback: true, when: [] },
      ],
    },
  })
  await expect(
    page.getByText(msg('wf.model.design.published', 'zh-CN', { version: 2 })),
  ).toBeVisible()
})

test('when overdue: hand to the manager, published, reopened as set', async ({ page, request }) => {
  const id = await newModel(
    request,
    { Authorization: await bearer(request) },
    'e2e-flow-timeout',
    null,
  )

  await signIn(page, 'admin', `/wf/models/${id}/design`)
  const { designer, drawer, addStep, configure, publish } = designerOf(page)
  await addStep(designer.getByRole('button', { name: add }), 'review')
  const card = designer.locator('.wf-card--review')
  await configure(card, 'E2E Due', 'oaSupervisor')
  const afterDue = drawer.getByRole('radiogroup', {
    name: msg('wf.designer.review.timeout.after.label'),
  })
  const handUp = afterDue.getByRole('radio', {
    name: msg('wf.designer.review.timeout.after.toManager'),
  })
  await card.locator('.wf-card__main').click()
  // the visible switch (its input is 0 × 0)
  await drawer
    .locator('.el-switch')
    .filter({ hasText: msg('wf.designer.review.timeout.label') })
    .click()
  await expect(
    afterDue.getByRole('radio', { name: msg('wf.designer.review.timeout.after.remind') }),
  ).toBeChecked()
  await afterDue.getByText(msg('wf.designer.review.timeout.after.toManager')).click()
  await expect(handUp).toBeChecked()
  await expect(drawer).toContainText(msg('wf.designer.review.timeout.afterHint.common'))
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()

  expect(await publish(id)).toMatchObject({
    next: { name: 'E2E Due', timeout: { hours: 24, action: 'toManager' } },
  })
  await expect(
    page.getByText(msg('wf.model.design.published', 'zh-CN', { version: 1 })),
  ).toBeVisible()

  // reopened from the server: still handed to the manager
  await page.reload()
  await card.locator('.wf-card__main').click()
  await expect(handUp).toBeChecked()
})

test('parallel fork: two reviews, published, started: both to-dos at once', async ({
  page,
  request,
}) => {
  const as = sessions(request)
  const name = 'e2e-flow-parallel'
  const id = await newModel(request, await as('admin'), name, null)

  await signIn(page, 'admin', `/wf/models/${id}/design`)
  const { designer, drawer, addStep, configure, publish } = designerOf(page)
  await addStep(designer.getByRole('button', { name: add }), 'fork')
  const fork = designer.locator('.wf-fork')
  // default paths have no conditions: switched without a question
  await fork
    .locator('.el-radio-button')
    .filter({ hasText: msg('wf.designer.fork.modes.parallel') })
    .click()
  const paths = fork.locator('.wf-fork__path')
  await expect(paths).toHaveCount(2)
  for (const [i, [step, user]] of (
    [
      ['E2E Left', 'oaSupervisor'],
      ['E2E Right', 'oaDirector'],
    ] as const
  ).entries()) {
    await expect(paths.nth(i)).toContainText(msg('wf.designer.summary.parallel'))
    await addStep(paths.nth(i).getByRole('button', { name: add }), 'review')
    await configure(paths.nth(i).locator('.wf-card--review'), step, user)
  }
  await expect(drawer).toBeHidden()
  const tree = await publish(id)
  await expect(
    page.getByText(msg('wf.model.design.published', 'zh-CN', { version: 1 })),
  ).toBeVisible()
  expect(tree).toMatchObject({
    next: {
      type: 'fork',
      mode: 'parallel',
      paths: [
        { when: [], child: { type: 'review', name: 'E2E Left' } },
        { when: [], child: { type: 'review', name: 'E2E Right' } },
      ],
    },
  })
  expect(tree.next!.paths!.some((p) => 'fallback' in p)).toBe(false)

  // started from 发起申请 (no step to pick for: the dialog only confirms)
  await page.goto('/workflow/start')
  await page.getByRole('button', { name, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: msg('wf.center.start.title', 'zh-CN', { name }) })
  const answered = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/wf/instances'),
  )
  await dialog.getByRole('button', { name: msg('wf.center.start.submit') }).click()
  const started = await answered
  expect(started.status()).toBe(201)
  const instance = ((await started.json()) as { data: { id: number; state: string } }).data
  expect(instance.state).toBe('running')

  // each path's reviewer holds a to-do at once
  const todo = async (user: E2eUser) => {
    const res = await request.get('/api/wf/tasks/todo', { headers: await as(user) })
    const rows = (
      (await res.json()) as {
        data: { items: { nodeName: string; instance: { id: number } }[] }
      }
    ).data.items
    return rows.filter((r) => r.instance.id === instance.id).map((r) => r.nodeName)
  }
  expect(await todo('oaSupervisor')).toEqual(['E2E Left'])
  expect(await todo('oaDirector')).toEqual(['E2E Right'])
})

test.describe('in English, 1440 × 900', () => {
  test.use({ locale: 'en-US', viewport: { width: 1440, height: 900 } })

  test('drawer: the who-reviews choices neither overlap nor run out of the drawer', async ({
    page,
    request,
  }) => {
    const en = 'en-US'
    const id = await newModel(
      request,
      { Authorization: await bearer(request) },
      'e2e-flow-en',
      null,
    )
    await signIn(page, 'admin', `/wf/models/${id}/design`)
    await expect(page.locator('html')).toHaveAttribute('lang', en)
    const { designer, drawer } = designerOf(page)
    await designer.getByRole('button', { name: msg('wf.designer.add', en) }).click()
    await page.getByRole('menuitem', { name: msg('wf.designer.type.review', en) }).click()
    await designer.locator('.wf-card--review .wf-card__main').click()
    await expect(drawer).toBeVisible()
    await kindsFit(drawer, en)
  })
})
