import { readFile } from 'node:fs/promises'
import type { APIRequestContext, Locator } from '@playwright/test'
import { treeToXml } from '@qiwu/shared'
import { USERS, type E2eUser } from './env.ts'
import { bearer, expect, msg, signIn, test, userId, type Page } from './fixtures.ts'

// Acceptance: the BPMN designer end to end. The admin adds a BPMN
// model on a dynamic form with an amount field and draws it: start → supervisor → an exclusive branch block
// (amount > 1000: finance | the default path) → a carbon copy → end; published, its .bpmn exported and imported
// back publishes the same tree. The employee starts 2000 (supervisor, then finance approve; approved, the copy
// arrives) and 500 (the default path); the instance's diagram marks the steps walked done and the path not taken
// skipped, the bpmn.io logo visible (light and dark). A parallel block drawn with two reviews has both to-dos at
// once. On a BPMN instance, send back to the initiator → resubmit and withdrawing an approval work as on a tree.
// A loop, two starts and a join of another type are refused and marked on the canvas until corrected. Every
// test fails on a CSP violation (fixture). The models these tests draw are the ones the docs show.

const SUP = '主管审批'
const FIN = '财务审批'
const AMOUNT = '金额'
/** a new carbon copy's default name */
const COPY = msg('wf.designer.type.notify')

const canvas = (page: Page) => page.locator('.wf-bpmn')
const shape = (page: Page, id: string) =>
  canvas(page).locator(`.djs-shape[data-element-id="${id}"]`)
/** a task by the name drawn inside it */
const task = (page: Page, name: string) =>
  canvas(page).locator('.djs-shape').filter({ hasText: name })
const flow = (page: Page, id: string) =>
  canvas(page).locator(`.djs-connection[data-element-id="${id}"]`)
const idOf = async (element: Locator) => (await element.getAttribute('data-element-id'))!
const panel = (page: Page) => page.locator('.wf-bpmn-panel')
const alert = (page: Page) => canvas(page).getByRole('alert')
const marked = (page: Page) => canvas(page).locator('.djs-element.qw-error')

/** Clears the selection: a click on the empty bottom of the canvas. */
async function deselect(page: Page) {
  const box = (await canvas(page).locator('.djs-container > svg').boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 20)
}

/**
 * Selects `element` (a click on the only selected element deselects it), the selection cleared first. A
 * straight flow's box has no height: clicked at its middle anyway.
 */
async function select(element: Locator) {
  const [selected, line] = await element.evaluate((e) => [
    e.classList.contains('selected'),
    e.classList.contains('djs-connection'),
  ])
  if (selected) return
  await deselect(element.page())
  await element.click({ force: line })
}

/** Selects `element` and runs a context pad entry on it. */
async function pad(page: Page, element: Locator, action: string) {
  await select(element)
  await page.locator(`.djs-context-pad [data-action="${action}"]`).click()
}

/** Names the element whose label is being edited. */
async function typeName(page: Page, name: string) {
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type(name)
  await page.keyboard.press('Enter')
}

/** Appends a review named `name` after `element`. */
async function appendReview(page: Page, element: Locator, name: string) {
  await pad(page, element, 'append.user-task')
  await typeName(page, name)
}

/**
 * A point on `line` where a dropped shape goes into it: a straight flow's middle (its box is as high as its
 * arrowhead), else on its bottom segment (a branch block's lower path).
 */
async function onFlow(line: Locator) {
  const box = (await line.locator('.djs-visual > path').boundingBox())!
  return {
    x: box.x + box.width / 2,
    y: box.height > 20 ? box.y + box.height - 1 : box.y + box.height / 2,
  }
}

/** Drops a new review named `name` from the palette into `line` (it splits the flow). */
async function dropReview(page: Page, line: Locator, name: string) {
  // the selection cleared first: the panel's pending edit (written 300 ms after the last change) goes in now,
  // not halfway through the drop (a command then ends it)
  await deselect(page)
  await canvas(page).locator('.djs-palette [data-action="create.user-task"]').click()
  // measured now: the check list above the canvas follows each edit and moves it
  const at = await onFlow(line)
  await page.mouse.move(at.x - 10, at.y - 10)
  await page.mouse.move(at.x, at.y)
  await page.mouse.click(at.x, at.y)
  await typeName(page, name)
}

/** The diagram as a draft save sends it. */
async function saved(page: Page, id: number) {
  const put = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && r.url().endsWith(`/api/wf/models/${id}/draft`),
  )
  await page.getByRole('button', { name: msg('wf.model.design.saveDraft') }).click()
  const res = await put
  expect(res.ok()).toBe(true)
  return (res.request().postDataJSON() as { xml: string }).xml
}

/** the sequence flows of `xml`, in document order (= path order) */
const flows = (xml: string) =>
  [
    ...xml.matchAll(
      /<bpmn:sequenceFlow id="([^"]+)"(?: name="[^"]*")? sourceRef="([^"]+)" targetRef="([^"]+)"/g,
    ),
  ].map(([, id, from, to]) => ({ id: id!, from: from!, to: to! }))

/** The block `insert.*-block` put after `from`: its fork, join and two paths (in order). */
function blockAfter(xml: string, from: string) {
  const all = flows(xml)
  const fork = all.find((f) => f.from === from)!.to
  const paths = all.filter((f) => f.from === fork)
  return { fork, join: paths[0]!.to, paths: paths.map((f) => f.id) as [string, string] }
}

/** Picks the user `login` as who the selected review / carbon copy goes to (the settings panel). */
async function pickUser(page: Page, login: string) {
  await panel(page)
    .getByRole('button', { name: msg('wf.designer.assignee.pickUsers') })
    .click()
  const picker = page.getByRole('dialog', { name: msg('picker.user.title') })
  await picker.getByRole('textbox', { name: msg('field.iam.user.keyword') }).fill(login)
  await picker.getByRole('row').filter({ hasText: login }).click()
  await picker.getByRole('button', { name: msg('picker.user.confirm') }).click()
  await expect(picker).toBeHidden()
}

/** Publishes from the design page (confirmed): version `version`. */
async function publishOnPage(page: Page, version: number) {
  await page.getByRole('button', { name: msg('wf.model.design.publish') }).click()
  await page
    .getByRole('dialog', { name: msg('wf.model.design.confirmTitle') })
    .getByRole('button', { name: msg('wf.model.design.publish') })
    .click()
  await expect(page.getByText(msg('wf.model.design.published', 'zh-CN', { version }))).toBeVisible()
}

/** Publish is refused before anything is sent: the designer's check lists `code` and marks the canvas. */
async function refused(page: Page, code: string) {
  await page.getByRole('button', { name: msg('wf.model.design.publish') }).click()
  for (const part of msg(`validation.wf.${code}`).split('{node}'))
    await expect(alert(page)).toContainText(part)
  await expect(marked(page)).not.toHaveCount(0)
  await expect(page.getByRole('dialog', { name: msg('wf.model.design.confirmTitle') })).toHaveCount(
    0,
  )
}

type Headers = Record<string, string>
/** the trees of the model's versions, newest first */
async function trees(request: APIRequestContext, headers: Headers, id: number) {
  const list = (await (await request.get(`/api/wf/models/${id}/versions`, { headers })).json()) as {
    data: { id: number }[]
  }
  return Promise.all(
    list.data.map(async (v) => {
      const res = await request.get(`/api/wf/models/${id}/versions/${v.id}`, { headers })
      return ((await res.json()) as { data: { tree: object } }).data.tree
    }),
  )
}

/** A dynamic BPMN model through the API (no form, no version yet); its id. */
async function bpmnModel(request: APIRequestContext, headers: Headers, key: string) {
  const res = await request.post('/api/wf/models', {
    headers,
    data: { modelKey: key, name: key, formKind: 'dynamic', category: 'finance', flowKind: 'bpmn' },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return ((await res.json()) as { data: { id: number } }).data.id
}

/** Opens the design page of model `id` (a new BPMN model: begin → an end). */
async function openDesign(page: Page, id: number) {
  await signIn(page, 'admin', `/wf/models/${id}/design`)
  await expect(shape(page, 'begin')).toBeVisible()
}

/** `user` starts `modelKey` through the API; the instance id. */
async function start(request: APIRequestContext, user: E2eUser, modelKey: string) {
  const res = await request.post('/api/wf/instances', {
    headers: { Authorization: await bearer(request, USERS[user]) },
    data: { modelKey },
  })
  expect(res.status(), await res.text()).toBe(201)
  return ((await res.json()) as { data: { id: number } }).data.id
}

/** the instance as `user` reads it */
async function detail(request: APIRequestContext, user: E2eUser, id: number) {
  const res = await request.get(`/api/wf/instances/${id}`, {
    headers: { Authorization: await bearer(request, USERS[user]) },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return (
    (await res.json()) as {
      data: { state: string; progress: Record<string, string> }
    }
  ).data
}

/** `user`'s pending to-dos on instance `id`: their step names */
async function todos(request: APIRequestContext, user: E2eUser, id: number) {
  const res = await request.get('/api/wf/tasks/todo', {
    headers: { Authorization: await bearer(request, USERS[user]) },
    params: { pageSize: 100 },
  })
  const page = (await res.json()) as {
    data: { items: { nodeName: string; instance: { id: number } }[] }
  }
  return page.data.items.filter((t) => t.instance.id === id).map((t) => t.nodeName)
}

const MODEL = { modelKey: 'e2e-bpmn-flow', name: 'E2E BPMN 报销' }
const FORM = 'E2E BPMN flow form'
const field = (prop: string) => msg(`field.wf.model.${prop}`)
const approveLabel = msg('wf.center.decide.approve')
const actions = (page: Page) => page.locator('.wf-detail__actions')

/** `user` approves their task on step `node` of instance `id` on its detail page. */
async function approveOnPage(page: Page, user: E2eUser, id: number, node: string) {
  await signIn(page, user, `/workflow/instances/${id}`)
  await actions(page).getByRole('button', { name: approveLabel, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: `${approveLabel} · ${node}` })
  const done = page.waitForResponse((r) => /\/api\/wf\/tasks\/\d+\/approve$/.test(r.url()))
  await dialog.getByRole('button', { name: approveLabel, exact: true }).click()
  expect((await done).status()).toBe(200)
  await expect(dialog).toBeHidden()
}

/** The employee starts the model on 发起申请 with `amount`; the instance id. */
async function startOnPage(page: Page, amount: number) {
  await signIn(page, 'oaEmployee', '/workflow/start')
  await page.getByRole('button', { name: MODEL.name, exact: true }).click()
  const dialog = page.getByRole('dialog', {
    name: msg('wf.center.start.title', 'zh-CN', { name: MODEL.name }),
  })
  const input = dialog.locator('.el-form-item', { hasText: AMOUNT }).locator('input')
  await input.fill(String(amount))
  await input.press('Tab')
  const started = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/wf/instances'),
  )
  await dialog.getByRole('button', { name: msg('wf.center.start.submit') }).click()
  const res = await started
  expect(res.status(), await res.text()).toBe(201)
  expect(res.request().postDataJSON()).toMatchObject({ formValues: { amount } })
  await expect(dialog).toBeHidden()
  return ((await res.json()) as { data: { id: number } }).data.id
}

/** the progress element `id` shows on the read-only diagram (its `qw-*` marker), else undefined */
const markOf = (page: Page, id: string) =>
  canvas(page)
    .locator(`.djs-element[data-element-id="${id}"]`)
    .evaluate((e) =>
      [...e.classList].find((c) => /^qw-(done|active|stopped|skipped)$/.test(c))?.slice(3),
    )

/** The bpmn.io logo of the diagram is there, on top where it is drawn (the full check: wf-bpmn-canvas). */
async function logoShown(page: Page) {
  const logo = canvas(page).locator('.bjs-powered-by')
  await expect(logo).toHaveCount(1)
  await expect(logo).toBeVisible()
  // the page's v-loading mask fades out for up to 0.4 s after its load, invisible but still hit
  await expect(page.locator('.el-loading-mask')).toHaveCount(0)
  await logo.scrollIntoViewIfNeeded()
  expect(
    await logo.evaluate((a) => {
      const box = a.getBoundingClientRect()
      return a.contains(
        a.ownerDocument.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
      )
    }),
  ).toBe(true)
}

test('flow: drawn on the canvas, published, exported and imported back; 2000 through finance, 500 the default path; the diagram marks both', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000)
  const root = { Authorization: await bearer(request) }
  const [supervisor, director, hr] = await Promise.all(
    [USERS.oaSupervisor, USERS.oaDirector, USERS.oaHr].map((u) =>
      userId(request, root, u.username),
    ),
  )
  const form = await request.post('/api/wf/forms', {
    headers: root,
    data: {
      name: FORM,
      schemaJson: { rule: [{ type: 'inputNumber', field: 'amount', title: AMOUNT }] },
    },
  })
  expect(form.status(), await form.text()).toBe(201)

  // 模型管理: a BPMN model on the form
  await signIn(page, 'admin', '/wf/models')
  await page.getByRole('button', { name: msg('crud.action.create'), exact: true }).click()
  const create = page.getByRole('dialog', {
    name: msg('crud.title.create', 'zh-CN', { name: msg('wf.model.entity') }),
  })
  await create.getByRole('textbox', { name: field('modelKey') }).fill(MODEL.modelKey)
  await create.getByRole('textbox', { name: field('name') }).fill(MODEL.name)
  await create.getByText(msg('wf.model.flowKinds.bpmn'), { exact: true }).click()
  await create
    .locator('.el-form-item', { hasText: field('formId') })
    .locator('.el-select')
    .click()
  await page.getByRole('option', { name: FORM, exact: true }).click()
  const created = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/wf/models',
  )
  await create.getByRole('button', { name: msg('crud.action.save') }).click()
  const id = ((await (await created).json()) as { data: { id: number } }).data.id
  await expect(create).toBeHidden()
  await page
    .locator('.qw-table-panel .el-table__body tr')
    .filter({ hasText: MODEL.name })
    .getByRole('button', { name: msg('wf.model.list.design') })
    .click()
  await expect(page).toHaveURL(new RegExp(`/wf/models/${id}/design$`))
  await expect(shape(page, 'begin')).toBeVisible()

  // begin → the supervisor → a copy to HR → end (who is picked in the panel as each step is added; the block
  // inserted next moves the copy right, out of view)
  await pad(page, shape(page, 'qwe_1'), 'delete')
  await appendReview(page, shape(page, 'begin'), SUP)
  await pickUser(page, USERS.oaSupervisor.username)
  await pad(page, task(page, SUP), 'append.send-task')
  await page.keyboard.press('Escape')
  await pickUser(page, USERS.oaHr.username)
  await pad(page, task(page, COPY), 'append.end-event')
  await page.keyboard.press('Escape')
  const [sup, copy] = [await idOf(task(page, SUP)), await idOf(task(page, COPY))]

  // an exclusive block after the supervisor: its first path amount > 1000 (the panel's condition), finance by
  // the finance director dropped into it; the other one the default
  await pad(page, task(page, SUP), 'insert.exclusive-block')
  const { fork, join, paths } = blockAfter(await saved(page, id), sup)
  const [big, other] = paths
  await select(flow(page, big))
  await panel(page)
    .getByRole('button', { name: msg('wf.designer.cond.addGroup') })
    .click()
  await panel(page)
    .getByRole('combobox', { name: msg('wf.designer.cond.op') })
    .click({ force: true })
  await page.getByRole('option', { name: msg('wf.designer.op.gt'), exact: true }).click()
  const value = panel(page).getByRole('spinbutton', { name: msg('wf.designer.cond.value') })
  await value.fill('1000')
  await value.blur()
  await dropReview(page, flow(page, big), FIN)
  await pickUser(page, USERS.oaDirector.username)
  const fin = await idOf(task(page, FIN))
  const xml = await saved(page, id)
  expect(flows(xml).filter((f) => [fork, fin].includes(f.from))).toEqual([
    { id: big, from: fork, to: fin },
    { id: other, from: fork, to: join },
    { id: expect.any(String), from: fin, to: join },
  ])
  await publishOnPage(page, 1)
  const review = (assignee: number) => ({
    type: 'review',
    assignee: { kind: 'users', ids: [assignee] },
    sign: 'any',
    onReject: 'finish',
  })
  const [v1] = await trees(request, root, id)
  expect(v1).toMatchObject({
    id: 'begin',
    next: {
      id: sup,
      name: SUP,
      ...review(supervisor),
      next: {
        id: fork,
        type: 'fork',
        mode: 'exclusive',
        paths: [
          {
            id: big,
            when: [[{ field: 'amount', op: 'gt', value: 1000 }]],
            child: { id: fin, name: FIN, ...review(director) },
          },
          { id: other, fallback: true, when: [] },
        ],
        next: { type: 'notify', name: COPY, assignee: { kind: 'users', ids: [hr] } },
      },
    },
  })

  // the canvas exported as .bpmn (imported back at the end)
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: msg('wf.model.design.exportBpmn') }).click()
  const exported = await readFile(await (await downloading).path(), 'utf8')

  // 2000: the supervisor, then finance; approved, the copy is HR's
  const large = await startOnPage(page, 2000)
  await approveOnPage(page, 'oaSupervisor', large, SUP)
  expect(await todos(request, 'oaDirector', large)).toEqual([FIN])
  await approveOnPage(page, 'oaDirector', large, FIN)
  expect((await detail(request, 'oaEmployee', large)).state).toBe('approved')
  const copies = await request.get('/api/wf/ccs/mine', {
    headers: { Authorization: await bearer(request, USERS.oaHr) },
    params: { pageSize: 100 },
  })
  const cc = (await copies.json()) as { data: { items: { instance: { id: number } }[] } }
  expect(cc.data.items.filter((c) => c.instance.id === large)).toHaveLength(1)

  // 500: the supervisor alone (the default path), approved
  const small = await startOnPage(page, 500)
  await approveOnPage(page, 'oaSupervisor', small, SUP)
  expect(await todos(request, 'oaDirector', small)).toEqual([])
  expect((await detail(request, 'oaEmployee', small)).state).toBe('approved')

  // the diagrams: the steps and paths walked done, the path not taken skipped
  const all = flows(xml)
  const out = (from: string) => all.find((f) => f.from === from)!.id
  const walked = ['begin', out('begin'), sup, out(sup), fork, join, out(join), copy, out(copy)]
  for (const [instance, taken, skipped] of [
    [large, [big, fin, out(fin)], [other]],
    [small, [other], [big, fin, out(fin)]],
  ] as const) {
    await signIn(page, 'oaEmployee', `/workflow/instances/${instance}`)
    await expect.poll(() => markOf(page, sup)).toBe('done')
    for (const el of [...walked, ...taken]) expect(await markOf(page, el), el).toBe('done')
    for (const el of skipped) expect(await markOf(page, el), el).toBe('skipped')
  }

  // the bpmn.io logo, light and dark
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.reload()
    const html = expect(page.locator('html'))
    await (scheme === 'dark' ? html : html.not).toHaveClass(/\bdark\b/)
    await expect.poll(() => markOf(page, sup)).toBe('done')
    await logoShown(page)
  }

  // the exported .bpmn imported back over a changed canvas (finance deleted, so a no-op import cannot pass) and
  // published (an equal body within 3 s would be a duplicate submit, 429): the server derives the same tree
  await page.emulateMedia({ colorScheme: 'light' })
  await openDesign(page, id)
  await pad(page, task(page, FIN), 'delete')
  await expect(task(page, FIN)).toHaveCount(0)
  await page.locator('.wf-model-design input[type=file]').setInputFiles({
    name: `${MODEL.modelKey}-draft.bpmn`,
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(exported),
  })
  const importing = page.getByRole('dialog', { name: msg('wf.model.design.importTitle') })
  await importing.getByRole('button', { name: msg('wf.model.design.import') }).click()
  await expect(importing).toBeHidden()
  await expect(task(page, FIN)).toBeVisible()
  await publishOnPage(page, 2)
  const [v2] = await trees(request, root, id)
  expect(v2).toEqual(v1)
})

test('parallel: a parallel block drawn with a review on each path; started, both to-dos at once', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000)
  const root = { Authorization: await bearer(request) }
  const key = 'e2e-bpmn-flow-parallel'
  const id = await bpmnModel(request, root, key)
  await openDesign(page, id)
  await pad(page, shape(page, 'begin'), 'insert.parallel-block')
  const { paths } = blockAfter(await saved(page, id), 'begin')
  // a review dropped into each path (the lower one on its bottom segment)
  for (const [path, name, login] of [
    [paths[0], SUP, USERS.oaSupervisor.username],
    [paths[1], FIN, USERS.oaDirector.username],
  ] as const) {
    await dropReview(page, flow(page, path), name)
    await pickUser(page, login)
  }
  await publishOnPage(page, 1)

  const instance = await start(request, 'oaEmployee', key)
  expect(await todos(request, 'oaSupervisor', instance)).toEqual([SUP])
  expect(await todos(request, 'oaDirector', instance)).toEqual([FIN])
  const { progress } = await detail(request, 'oaEmployee', instance)
  const [left, right] = [await idOf(task(page, SUP)), await idOf(task(page, FIN))]
  expect([progress[left], progress[right]]).toEqual(['active', 'active'])
})

/** begin → check (the supervisor) → after (the director), a BPMN model published through the API */
function twoSteps(supervisor: number, director: number) {
  const review = (id: string, name: string, user: number, next?: object) => ({
    id,
    type: 'review',
    name,
    assignee: { kind: 'users', ids: [user] },
    sign: 'any',
    whenNobody: 'toManager',
    whenInitiatorIsReviewer: 'self',
    onReject: 'finish',
    next,
  })
  return {
    id: 'begin',
    type: 'begin',
    name: 'Begin',
    next: review('check', SUP, supervisor, review('after', FIN, director)),
  } as Parameters<typeof treeToXml>[0]
}

test('actions: on a BPMN instance, sent back to the initiator and resubmitted; an approval withdrawn', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000)
  const root = { Authorization: await bearer(request) }
  const key = 'e2e-bpmn-flow-actions'
  const id = await bpmnModel(request, root, key)
  const [supervisor, director] = await Promise.all(
    [USERS.oaSupervisor, USERS.oaDirector].map((u) => userId(request, root, u.username)),
  )
  const v1 = await request.post(`/api/wf/models/${id}/versions`, {
    headers: root,
    data: { xml: treeToXml(twoSteps(supervisor, director)), fields: {} },
  })
  expect(v1.ok(), await v1.text()).toBe(true)
  const instance = await start(request, 'oaEmployee', key)
  const path = `/workflow/instances/${instance}`
  const label = (key: string) => msg(`wf.center.decide.${key}`)
  const answer = (action: string) =>
    page.waitForResponse((r) => new RegExp(`/api/wf/tasks/\\d+/${action}$`).test(r.url()))

  // the supervisor sends it back to the initiator
  await signIn(page, 'oaSupervisor', path)
  await actions(page)
    .getByRole('button', { name: label('sendBack'), exact: true })
    .click()
  let dialog = page.getByRole('dialog', { name: `${label('sendBack')} · ${SUP}` })
  await dialog
    .locator('.el-radio')
    .filter({ hasText: msg('wf.center.list.initiator') })
    .click()
  let done = answer('send-back')
  await dialog.getByRole('button', { name: label('sendBack'), exact: true }).click()
  expect((await done).status()).toBe(200)
  await expect(dialog).toBeHidden()

  // the employee resubmits: the supervisor holds the step again
  await signIn(page, 'oaEmployee', path)
  await actions(page)
    .getByRole('button', { name: label('resubmit') })
    .click()
  dialog = page.getByRole('dialog', { name: label('resubmit') })
  done = answer('resubmit')
  await dialog.getByRole('button', { name: label('resubmit'), exact: true }).click()
  expect((await done).status()).toBe(200)
  await expect(dialog).toBeHidden()
  expect(await todos(request, 'oaSupervisor', instance)).toEqual([SUP])

  // approved, the director's step untouched: withdrawn, the supervisor's again
  await approveOnPage(page, 'oaSupervisor', instance, SUP)
  expect(await todos(request, 'oaDirector', instance)).toEqual([FIN])
  await actions(page)
    .getByRole('button', { name: label('withdraw'), exact: true })
    .click()
  dialog = page.getByRole('dialog', { name: `${label('withdraw')} · ${SUP}` })
  done = answer('withdraw')
  await dialog.getByRole('button', { name: label('withdraw'), exact: true }).click()
  expect((await done).status()).toBe(200)
  await expect(dialog).toBeHidden()
  await expect(actions(page).getByRole('button', { name: approveLabel, exact: true })).toBeVisible()
  expect(await todos(request, 'oaDirector', instance)).toEqual([])
  expect(await todos(request, 'oaSupervisor', instance)).toEqual([SUP])
})

test('refused: a loop, a second start and a join of another type are marked on the canvas until corrected; then it publishes', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000)
  const root = { Authorization: await bearer(request) }
  const id = await bpmnModel(request, root, 'e2e-bpmn-flow-refused')
  await openDesign(page, id)
  // begin → a parallel block with two empty paths → end
  await pad(page, shape(page, 'begin'), 'insert.parallel-block')
  const { fork, join, paths } = blockAfter(await saved(page, id), 'begin')
  const undo = async (steps: number) => {
    await canvas(page).locator('.djs-container > svg').focus()
    for (let i = 0; i < steps; i++) await page.keyboard.press('ControlOrMeta+z')
  }
  const fine = () => expect(marked(page)).toHaveCount(0)

  // a loop: one path dropped, the join connected back to the fork
  await pad(page, flow(page, paths[0]), 'delete')
  await pad(page, shape(page, join), 'connect')
  await shape(page, fork).click()
  await refused(page, 'bpmn_cycle')
  await undo(2)
  await fine()

  // a second start, from the palette
  await deselect(page)
  await canvas(page).locator('.djs-palette [data-action="create.start-event"]').click()
  const box = (await canvas(page).locator('.djs-container > svg').boundingBox())!
  const at = { x: box.x + box.width * 0.4, y: box.y + box.height - 80 }
  await page.mouse.move(at.x - 10, at.y - 10)
  await page.mouse.move(at.x, at.y)
  await page.mouse.click(at.x, at.y)
  const starts = [...(await saved(page, id)).matchAll(/<bpmn:startEvent id="([^"]+)"/g)].map(
    ([, s]) => s!,
  )
  expect(starts).toHaveLength(2)
  await refused(page, 'bpmn_start')
  const second = shape(
    page,
    starts.find((s) => s !== 'begin')!,
  )
  await expect(second).toHaveClass(/qw-error/)
  await pad(page, second, 'delete')
  await fine()

  // the join changed into an exclusive one: the fork is marked
  await pad(page, shape(page, join), 'replace')
  await page.locator('.djs-popup [data-id="replace-with-exclusive-gateway"]').click()
  await refused(page, 'bpmn_join_type')
  await expect(shape(page, fork)).toHaveClass(/qw-error/)
  await pad(page, shape(page, join), 'replace')
  await page.locator('.djs-popup [data-id="replace-with-parallel-gateway"]').click()
  await fine()

  // corrected: it publishes
  await publishOnPage(page, 1)
  const [tree] = await trees(request, root, id)
  expect(tree).toMatchObject({ next: { id: fork, type: 'fork', mode: 'parallel' } })
})
