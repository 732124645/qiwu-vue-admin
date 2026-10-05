import { readFileSync } from 'node:fs'
import type { APIRequestContext, Locator } from '@playwright/test'
import { treeToXml } from '@qiwu/shared'
import { USERS } from './env.ts'
import { bearer, expect, kindsFit, msg, signIn, test, userId, type Page } from './fixtures.ts'

// BPMN designer. "canvas": a BPMN model's design page shows the
// bpmn-js canvas; start → review → end drawn there publishes through every server check (the XML bpmn-js
// writes passes the strict parse and the allowlists); a loop is marked before any publish request; unsaved
// edits ask before leaving. "palette" / "helpers": the palette, context pad and change menu offer exactly
// the element subset; a branch block comes with its join, a fork's type change takes the join along, a carbon
// copy turned review gets review settings, an undone delete keeps the flow order. "panel": the settings
// panel beside the canvas writes who reviews, the sign mode, field access, a path's condition, the default path,
// the path order and a new path, one undo step each; a copied and pasted review keeps its settings. Models are
// created through the API (root). The canvas is driven through bpmn-js's own palette / context pad (`data-action`) and popup
// menu (`data-id`) entries; what it holds is read from the XML a draft save sends. "i18n" / "csp" / "watermark":
// the canvas texts in the app language, switched at runtime; the designer, its menus and the logo's notice
// under the SPA CSP; the bpmn.io logo visible, on top and unaltered beside the open panel, light and dark.
// "viewer" / "watermark": a BPMN model's instance detail shows its version as a read-only diagram marked by the
// instance's progress (joins and inner flows filled in, an id the diagram lacks skipped); its logo intact, light
// and dark, in print too.

/** a review's settings (`qw:Config`): the initiator reviews */
const REVIEW = {
  assignee: { kind: 'initiator' },
  sign: 'any',
  whenNobody: 'toManager',
  whenInitiatorIsReviewer: 'self',
  onReject: 'finish',
}

/**
 * A dynamic BPMN model (no draft yet: the page starts it as the begin node's diagram); its id. With `fields`,
 * v1 (begin → end, the page's start too) is published with them: a dynamic model without a form takes its
 * fields from there.
 */
async function bpmnModel(
  request: APIRequestContext,
  headers: Record<string, string>,
  key: string,
  fields?: Record<string, string>,
) {
  const res = await request.post('/api/wf/models', {
    headers,
    data: { modelKey: key, name: key, formKind: 'dynamic', category: 'finance', flowKind: 'bpmn' },
  })
  expect(res.ok(), await res.text()).toBe(true)
  const { id } = ((await res.json()) as { data: { id: number } }).data
  if (fields) {
    const xml = treeToXml({ id: 'begin', type: 'begin', name: msg('wf.designer.type.begin') })
    const v1 = await request.post(`/api/wf/models/${id}/versions`, {
      headers,
      data: { xml, fields },
    })
    expect(v1.ok(), await v1.text()).toBe(true)
  }
  return id
}

const canvas = (page: Page) => page.locator('.wf-bpmn')
const shape = (page: Page, id: string) =>
  canvas(page).locator(`.djs-shape[data-element-id="${id}"]`)
/** a task by the name drawn inside it */
const task = (page: Page, name: string) =>
  canvas(page).locator('.djs-shape').filter({ hasText: name })

/**
 * Selects `element` (a click on the only selected element deselects it), the selection cleared first (a click
 * on the empty bottom of the canvas): a selected element's context pad may cover it. A straight flow's box has
 * no height (Playwright: not visible): clicked at its middle anyway, on the line.
 */
async function select(element: Locator) {
  const [selected, flow] = await element.evaluate((e) => [
    e.classList.contains('selected'),
    e.classList.contains('djs-connection'),
  ])
  if (selected) return
  const box = (await canvas(element.page()).locator('.djs-container > svg').boundingBox())!
  await element.page().mouse.click(box.x + box.width / 2, box.y + box.height - 20)
  await element.click({ force: flow })
}

/** Selects `element` and runs a context pad entry on it. */
async function pad(page: Page, element: Locator, action: string) {
  await select(element)
  await page.locator(`.djs-context-pad [data-action="${action}"]`).click()
}

/** Appends a review named `name` after `element` (its default name replaced). */
async function appendReview(page: Page, element: Locator, name: string) {
  await pad(page, element, 'append.user-task')
  // the new review's label is being edited
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type(name)
  await page.keyboard.press('Enter')
}

/** Appends an end event after `element` (its label edit cancelled). */
async function appendEnd(page: Page, element: Locator) {
  await pad(page, element, 'append.end-event')
  await page.keyboard.press('Escape')
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
/** the gateways of `xml`: id → mode and default flow */
const gateways = (xml: string) =>
  Object.fromEntries(
    [...xml.matchAll(/<bpmn:(exclusive|parallel|inclusive)Gateway id="([^"]+)"([^>]*)>/g)].map(
      ([, mode, id, rest]) => [id!, { mode, default: /default="([^"]+)"/.exec(rest!)?.[1] }],
    ),
  )
/** The block `insert.*-block` put after `from`: its fork, join and two paths (in order). */
function blockAfter(xml: string, from: string) {
  const all = flows(xml)
  const fork = all.find((f) => f.from === from)!.to
  const paths = all.filter((f) => f.from === fork)
  return { fork, join: paths[0]!.to, paths: paths.map((f) => f.id) }
}

/** `data-action` / `data-id` of the entries in `menu`, sorted */
const entries = (menu: Locator, attr = 'data-action') =>
  menu.locator(`[${attr}]`).evaluateAll((els, a) => els.map((e) => e.getAttribute(a)).sort(), attr)
const padEntries = (page: Page) => entries(page.locator('.djs-context-pad'))
/** the change-type menu of `element` (left open) */
async function changeMenu(page: Page, element: Locator) {
  await pad(page, element, 'replace')
  return entries(page.locator('.djs-popup'), 'data-id')
}
/**
 * Closes the open popup menu with Escape. The menu listens for Escape in a Preact `useEffect`, attached a frame
 * after the menu shows: a key pressed before that is lost, so a frame passes first.
 */
async function closeMenu(page: Page) {
  await page.evaluate('new Promise((done) => requestAnimationFrame(() => setTimeout(done)))')
  await page.keyboard.press('Escape')
  await expect(page.locator('.djs-popup')).toHaveCount(0)
}
const flow = (page: Page, id: string) =>
  canvas(page).locator(`.djs-connection[data-element-id="${id}"]`)

/** Undo / redo one step (the keyboard acts on the focused canvas). */
async function undo(page: Page, redo = false) {
  await canvas(page).locator('.djs-container > svg').focus()
  await page.keyboard.press(redo ? 'ControlOrMeta+Shift+z' : 'ControlOrMeta+z')
}

async function openDesign(page: Page, id: number) {
  await signIn(page, 'admin', `/wf/models/${id}/design`)
  // the new model's diagram: the begin node and an end
  await expect(shape(page, 'begin')).toBeVisible()
  await expect(shape(page, 'qwe_1')).toBeVisible()
}

test('canvas: start → review → end drawn on the canvas publishes through the server checks', async ({
  page,
  request,
}) => {
  const headers = { Authorization: await bearer(request) }
  const id = await bpmnModel(request, headers, 'e2e-bpmn-canvas')
  await openDesign(page, id)

  // begin → Boss (user task) → a new end
  await pad(page, shape(page, 'qwe_1'), 'delete')
  await expect(shape(page, 'qwe_1')).toHaveCount(0)
  await appendReview(page, shape(page, 'begin'), 'Boss')
  await appendEnd(page, task(page, 'Boss'))
  const draft = await saved(page, id)
  // a new review: its default settings in a qw:Config, nobody picked yet
  expect(draft).toMatch(
    /<bpmn:userTask id="[\w-]+" name="Boss">\s*<bpmn:extensionElements>\s*<qw:Config>/,
  )

  // the reviewer, as the settings panel will write it
  const withConfig = draft.replace(
    /<qw:Config>[^<]*<\/qw:Config>/,
    `<qw:Config>${JSON.stringify(REVIEW)}</qw:Config>`,
  )
  const put = await request.put(`/api/wf/models/${id}/draft`, {
    headers,
    data: { xml: withConfig },
  })
  expect(put.ok(), await put.text()).toBe(true)
  await page.reload()
  await expect(task(page, 'Boss')).toBeVisible()

  // published from the canvas: bpmn-js's XML through the server's strict parse, allowlists and compile
  const published = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url().endsWith(`/api/wf/models/${id}/versions`),
  )
  await page.getByRole('button', { name: msg('wf.model.design.publish') }).click()
  await page
    .getByRole('dialog', { name: msg('wf.model.design.confirmTitle') })
    .getByRole('button', { name: msg('wf.model.design.publish') })
    .click()
  expect((await published).postDataJSON()).toMatchObject({
    xml: expect.stringContaining('qw:Config'),
    fields: {},
  })
  await expect(
    page.getByText(msg('wf.model.design.published', 'zh-CN', { version: 1 })),
  ).toBeVisible()
  await expect(
    page.getByText(msg('wf.model.design.current', 'zh-CN', { version: 1 })),
  ).toBeVisible()
  const versions = (await (
    await request.get(`/api/wf/models/${id}/versions`, { headers })
  ).json()) as { data: { id: number }[] }
  const v1 = (await (
    await request.get(`/api/wf/models/${id}/versions/${versions.data[0]!.id}`, { headers })
  ).json()) as { data: { tree: object; bpmnXml: string } }
  expect(v1.data.tree).toMatchObject({
    id: 'begin',
    type: 'begin',
    next: { type: 'review', name: 'Boss', ...REVIEW },
  })
  expect(v1.data.bpmnXml).toContain('<bpmn:userTask')
})

test('canvas: a loop is marked before publishing, nothing is sent', async ({ page, request }) => {
  const headers = { Authorization: await bearer(request) }
  const id = await bpmnModel(request, headers, 'e2e-bpmn-loop')
  await openDesign(page, id)

  // begin → fork ⇉ join → end, then one path dropped and join → fork drawn: around the loop the fork merges
  // and the join branches, every flow count still right
  await pad(page, shape(page, 'begin'), 'insert.parallel-block')
  const { fork, join, paths } = blockAfter(await saved(page, id), 'begin')
  await pad(page, flow(page, paths[0]!), 'delete')
  await pad(page, shape(page, join), 'connect')
  await shape(page, fork).click()

  const publishes: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith(`/api/wf/models/${id}/versions`))
      publishes.push(r.url())
  })
  await page.getByRole('button', { name: msg('wf.model.design.publish') }).click()
  const loop = msg('validation.wf.bpmn_cycle').split('{node}')
  await expect(canvas(page).getByRole('alert')).toContainText(loop[0]!)
  await expect(canvas(page).getByRole('alert')).toContainText(loop[1]!)
  await expect(canvas(page).locator('.djs-element.qw-error')).not.toHaveCount(0)
  await expect(page.getByRole('dialog', { name: msg('wf.model.design.confirmTitle') })).toHaveCount(
    0,
  )
  expect(publishes).toEqual([])
})

test('canvas: unsaved edits ask before leaving; saved, back leaves', async ({ page, request }) => {
  const headers = { Authorization: await bearer(request) }
  const id = await bpmnModel(request, headers, 'e2e-bpmn-leaving')
  await openDesign(page, id)
  const url = new RegExp(`/wf/models/${id}/design$`)
  const back = page.getByRole('button', { name: msg('wf.model.design.back') })
  const leave = page.getByRole('dialog', { name: msg('wf.model.design.leaveTitle') })

  await pad(page, shape(page, 'qwe_1'), 'delete')
  await back.click()
  await leave.getByRole('button', { name: msg('common.action.cancel') }).click()
  await expect(leave).toBeHidden()
  await expect(page).toHaveURL(url)
  await expect(shape(page, 'qwe_1')).toHaveCount(0)

  await page.getByRole('button', { name: msg('wf.model.design.saveDraft') }).click()
  await expect(page.getByText(msg('wf.model.design.draftSaved'))).toBeVisible()
  await back.click()
  await expect(page).toHaveURL(/\/wf\/models$/)
  await expect(leave).toHaveCount(0)
})

test('canvas: a publish the server refuses marks the elements its errors name', async ({
  page,
  request,
}) => {
  const headers = { Authorization: await bearer(request) }
  const id = await bpmnModel(request, headers, 'e2e-bpmn-refused')
  await openDesign(page, id)
  // the server's answer when its check differs from the designer's (e.g. the form changed meanwhile)
  await page.route(`**/api/wf/models/${id}/versions`, (route) =>
    route.fulfill({
      status: 400,
      contentType: 'application/json',
      json: {
        code: 'A0400',
        msg: 'refused',
        data: null,
        errors: [
          { path: 'xml.begin', msg: 'E2E the start is refused' },
          { path: 'xml', msg: 'E2E the diagram is refused' },
        ],
        traceId: 't-e2e',
      },
    }),
  )
  await page.getByRole('button', { name: msg('wf.model.design.publish') }).click()
  await page
    .getByRole('dialog', { name: msg('wf.model.design.confirmTitle') })
    .getByRole('button', { name: msg('wf.model.design.publish') })
    .click()
  const alert = canvas(page).getByRole('alert')
  await expect(alert).toContainText('E2E the start is refused')
  await expect(alert).toContainText('E2E the diagram is refused')
  await expect(shape(page, 'begin')).toHaveClass(/qw-error/)
  await expect(canvas(page).locator('.djs-element.qw-error')).toHaveCount(1)

  // stale once the diagram changes: the designer's own check follows the edits from now on
  await pad(page, shape(page, 'qwe_1'), 'delete')
  await expect(alert).not.toContainText('E2E')
  await expect(alert).toContainText(msg('validation.wf.bpmn_arity').split('{node}')[0]!)
})

/** context pad entries adding after an element */
const APPENDS = [
  'append.user-task',
  'append.send-task',
  'append.end-event',
  'insert.exclusive-block',
  'insert.parallel-block',
  'insert.inclusive-block',
]
const sorted = (...keys: string[]) => keys.sort()

test('palette: the palette, context pad and change menu offer exactly the element subset', async ({
  page,
  request,
}) => {
  const headers = { Authorization: await bearer(request) }
  const id = await bpmnModel(request, headers, 'e2e-bpmn-palette')
  await openDesign(page, id)

  // tools, start, end, review, carbon copy, three gateways
  expect(await entries(canvas(page).locator('.djs-palette'))).toEqual(
    sorted(
      'hand-tool',
      'lasso-tool',
      'space-tool',
      'global-connect-tool',
      'create.start-event',
      'create.end-event',
      'create.user-task',
      'create.send-task',
      'create.exclusive-gateway',
      'create.parallel-gateway',
      'create.inclusive-gateway',
    ),
  )
  // a start changes into nothing, an end has nothing after it, a start's flow is no default flow
  await select(shape(page, 'begin'))
  expect(await padEntries(page)).toEqual(sorted(...APPENDS, 'connect', 'delete'))
  await select(shape(page, 'qwe_1'))
  expect(await padEntries(page)).toEqual(sorted('connect', 'delete'))
  await select(canvas(page).locator('.djs-connection'))
  expect(await padEntries(page)).toEqual(['delete'])

  // gateways change into each other, a fork's path into its default path
  await pad(page, shape(page, 'begin'), 'insert.exclusive-block')
  const xml = await saved(page, id)
  const { fork, join, paths } = blockAfter(xml, 'begin')
  await select(shape(page, fork))
  expect(await padEntries(page)).toEqual(sorted(...APPENDS, 'connect', 'replace', 'delete'))
  expect(await changeMenu(page, shape(page, fork))).toEqual(
    sorted('replace-with-inclusive-gateway', 'replace-with-parallel-gateway'),
  )
  await closeMenu(page)
  await select(flow(page, paths[0]!))
  expect(await padEntries(page)).toEqual(sorted('replace', 'delete'))
  expect(await changeMenu(page, flow(page, paths[0]!))).toEqual(['replace-with-default-flow'])
  await closeMenu(page)
  // a join's only flow is no default path (rule ⑤)
  await select(flow(page, flows(xml).find((f) => f.from === join)!.id))
  expect(await padEntries(page)).toEqual(['delete'])

  // a review and a carbon copy change into each other only (no loop / multi-instance toggles); a default
  // name follows the type
  await pad(page, shape(page, join), 'append.user-task')
  await page.keyboard.press('Escape')
  const review = task(page, msg('wf.designer.type.review'))
  await select(review)
  expect(await padEntries(page)).toEqual(sorted(...APPENDS, 'connect', 'replace', 'delete'))
  expect(await changeMenu(page, review)).toEqual(['replace-with-send-task'])
  await page.locator('.djs-popup [data-id="replace-with-send-task"]').click()
  expect(await changeMenu(page, task(page, msg('wf.designer.type.notify')))).toEqual([
    'replace-with-user-task',
  ])
})

test('helpers: a branch block comes with its join; one undo takes it all back', async ({
  page,
  request,
}) => {
  const headers = { Authorization: await bearer(request) }
  const id = await bpmnModel(request, headers, 'e2e-bpmn-block')
  await openDesign(page, id)
  const before = await saved(page, id)

  await pad(page, shape(page, 'begin'), 'insert.exclusive-block')
  const xml = await saved(page, id)
  const { fork, join, paths } = blockAfter(xml, 'begin')
  // begin → fork ⇉ join → the end (the start's flow now leaves the join); the second path is the fallback
  expect(flows(xml)).toEqual([
    { ...flows(before)[0]!, from: join },
    { id: expect.any(String), from: 'begin', to: fork },
    { id: paths[0], from: fork, to: join },
    { id: paths[1], from: fork, to: join },
  ])
  expect(gateways(xml)).toEqual({
    [fork]: { mode: 'exclusive', default: paths[1] },
    [join]: { mode: 'exclusive' },
  })

  await undo(page)
  const back = await saved(page, id)
  expect(flows(back)).toEqual(flows(before))
  expect(gateways(back)).toEqual({})
})

test('helpers: a fork changing type takes its join along, in one undo step', async ({
  page,
  request,
}) => {
  const headers = { Authorization: await bearer(request) }
  const id = await bpmnModel(request, headers, 'e2e-bpmn-retype')
  await openDesign(page, id)
  await pad(page, shape(page, 'begin'), 'insert.exclusive-block')
  const { fork } = blockAfter(await saved(page, id), 'begin')

  await changeMenu(page, shape(page, fork))
  await page.locator('.djs-popup [data-id="replace-with-parallel-gateway"]').click()
  const xml = await saved(page, id)
  const block = blockAfter(xml, 'begin')
  expect(gateways(xml)).toEqual({
    [block.fork]: { mode: 'parallel' },
    [block.join]: { mode: 'parallel' },
  })

  await undo(page)
  const back = await saved(page, id)
  expect(Object.values(gateways(back)).map((g) => g.mode)).toEqual(['exclusive', 'exclusive'])
  expect(blockAfter(back, 'begin').fork).toBe(fork)
})

/** the reviews' and carbon copies' types, names and `qw:Config` settings in `xml` */
const settings = (xml: string) =>
  [
    ...xml.matchAll(
      /<bpmn:(userTask|sendTask) id="[^"]+" name="([^"]*)">\s*<bpmn:extensionElements>\s*<qw:Config>([^<]*)<\/qw:Config>/g,
    ),
  ].map(([, type, name, body]) => ({ type, name, config: JSON.parse(body!) as unknown }))

test('helpers: a carbon copy changed into a review gets review settings, keeps who is picked, publishes; one undo restores it', async ({
  page,
  request,
}) => {
  const headers = { Authorization: await bearer(request) }
  const id = await bpmnModel(request, headers, 'e2e-bpmn-copy-review')
  await openDesign(page, id)
  const copyName = msg('wf.designer.type.notify')
  const reviewName = msg('wf.designer.type.review')

  // begin → a new carbon copy (default name and settings) → an end
  await pad(page, shape(page, 'qwe_1'), 'delete')
  await pad(page, shape(page, 'begin'), 'append.send-task')
  await page.keyboard.press('Escape')
  await appendEnd(page, task(page, copyName))
  const draft = await saved(page, id)
  expect(settings(draft)).toEqual([
    { type: 'sendTask', name: copyName, config: { assignee: { kind: 'users', ids: [] } } },
  ])
  // the initiator picked, as the settings panel will write it
  const COPY = { assignee: { kind: 'initiator' } }
  const put = await request.put(`/api/wf/models/${id}/draft`, {
    headers,
    data: {
      xml: draft.replace(
        /<qw:Config>[^<]*<\/qw:Config>/,
        `<qw:Config>${JSON.stringify(COPY)}</qw:Config>`,
      ),
    },
  })
  expect(put.ok(), await put.text()).toBe(true)
  await page.reload()

  // into a review: review defaults, the initiator still picked, the default name follows
  await changeMenu(page, task(page, copyName))
  await page.locator('.djs-popup [data-id="replace-with-user-task"]').click()
  await expect(task(page, reviewName)).toBeVisible()
  expect(settings(await saved(page, id))).toEqual([
    { type: 'userTask', name: reviewName, config: REVIEW },
  ])

  // one undo: the carbon copy as it was; redone, it publishes through the server checks
  await undo(page)
  expect(settings(await saved(page, id))).toEqual([
    { type: 'sendTask', name: copyName, config: COPY },
  ])
  await undo(page, true)
  await expect(task(page, reviewName)).toBeVisible()
  await page.getByRole('button', { name: msg('wf.model.design.publish') }).click()
  await page
    .getByRole('dialog', { name: msg('wf.model.design.confirmTitle') })
    .getByRole('button', { name: msg('wf.model.design.publish') })
    .click()
  await expect(
    page.getByText(msg('wf.model.design.published', 'zh-CN', { version: 1 })),
  ).toBeVisible()
})

test('helpers: a fork path deleted and the delete undone keeps the path order', async ({
  page,
  request,
}) => {
  const headers = { Authorization: await bearer(request) }
  const id = await bpmnModel(request, headers, 'e2e-bpmn-order')
  await openDesign(page, id)
  await pad(page, shape(page, 'begin'), 'insert.exclusive-block')
  const xml = await saved(page, id)
  const { paths } = blockAfter(xml, 'begin')

  // the first path (evaluated first) deleted, then back: still first (bpmn-js alone appends it last)
  await pad(page, flow(page, paths[0]!), 'delete')
  await expect(flow(page, paths[0]!)).toHaveCount(0)
  await undo(page)
  await expect(flow(page, paths[0]!)).toHaveCount(1)
  const back = await saved(page, id)
  expect(flows(back)).toEqual(flows(xml))
  expect(blockAfter(back, 'begin').paths).toEqual(paths)
})

const panel = (page: Page) => page.locator('.wf-bpmn-panel')
/** the panel shows `title` (the selected element's kind) */
const showing = (page: Page, title: string) =>
  expect(panel(page).getByRole('heading', { name: title })).toBeVisible()
/** a new review's settings: nobody picked yet */
const NEW_REVIEW = { ...REVIEW, assignee: { kind: 'users', ids: [] } }
/** the flows' `qw-rule` conditions in `xml`: flow id → `when` */
const conditions = (xml: string) =>
  Object.fromEntries(
    [
      ...xml.matchAll(
        /<bpmn:sequenceFlow id="([^"]+)"[^>]*>\s*<bpmn:conditionExpression [^>]*language="qw-rule"[^>]*>([^<]*)</g,
      ),
    ].map(([, id, body]) => [id!, JSON.parse(body!) as unknown]),
  )
/** publishes from the page (confirmed); the version the server made */
async function publishOnPage(page: Page, version: number) {
  await page.getByRole('button', { name: msg('wf.model.design.publish') }).click()
  await page
    .getByRole('dialog', { name: msg('wf.model.design.confirmTitle') })
    .getByRole('button', { name: msg('wf.model.design.publish') })
    .click()
  await expect(page.getByText(msg('wf.model.design.published', 'zh-CN', { version }))).toBeVisible()
}
/** the tree of the model's latest version */
async function latestTree(request: APIRequestContext, headers: Record<string, string>, id: number) {
  const list = (await (await request.get(`/api/wf/models/${id}/versions`, { headers })).json()) as {
    data: { id: number }[]
  }
  const v = (await (
    await request.get(`/api/wf/models/${id}/versions/${list.data[0]!.id}`, { headers })
  ).json()) as { data: { tree: object } }
  return v.data.tree
}

test('panel: who reviews, the sign mode and field access go into the qw:Config, one undo step each; it publishes', async ({
  page,
  request,
}) => {
  const headers = { Authorization: await bearer(request) }
  const id = await bpmnModel(request, headers, 'e2e-bpmn-panel-review', { amount: 'number' })
  const supervisor = await userId(request, headers, USERS.oaSupervisor.username)
  await openDesign(page, id)
  await expect(panel(page)).toContainText(msg('wf.bpmn.panel.empty'))
  await pad(page, shape(page, 'qwe_1'), 'delete')
  await appendReview(page, shape(page, 'begin'), 'Boss')
  await appendEnd(page, task(page, 'Boss'))
  await select(task(page, 'Boss'))
  await showing(page, msg('wf.designer.drawer.review'))
  const side = panel(page)

  // the reviewer picked
  await side.getByRole('button', { name: msg('wf.designer.assignee.pickUsers') }).click()
  const picker = page.getByRole('dialog', { name: msg('picker.user.title') })
  const login = USERS.oaSupervisor.username
  await picker.getByRole('textbox', { name: msg('field.iam.user.keyword') }).fill(login)
  await picker.getByRole('row').filter({ hasText: login }).click()
  await picker.getByRole('button', { name: msg('picker.user.confirm') }).click()
  await expect(picker).toBeHidden()
  const picked = { ...NEW_REVIEW, assignee: { kind: 'users', ids: [supervisor] } }
  const boss = (config: object) => [{ type: 'userTask', name: 'Boss', config }]
  expect(settings(await saved(page, id))).toEqual(boss(picked))

  // all of them approve; one undo takes just that back (the panel reads it again), redo restores it
  const all = side.getByRole('radio', { name: msg('wf.designer.review.sign.all') })
  await side.getByText(msg('wf.designer.review.sign.all')).click()
  await expect(all).toBeChecked()
  expect(settings(await saved(page, id))).toEqual(boss({ ...picked, sign: 'all' }))
  await undo(page)
  await expect(side.getByRole('radio', { name: msg('wf.designer.review.sign.any') })).toBeChecked()
  expect(settings(await saved(page, id))).toEqual(boss(picked))
  await undo(page, true)
  await expect(all).toBeChecked()

  // the amount editable for the reviewer
  const edit = `amount ${msg('wf.designer.access.edit')}`
  await side
    .locator('label.el-radio')
    .filter({ has: page.getByRole('radio', { name: edit }) })
    .click()
  await expect(side.getByRole('radio', { name: edit })).toBeChecked()
  const done = { ...picked, sign: 'all', access: { amount: 'edit' } }
  expect(settings(await saved(page, id))).toEqual(boss(done))

  // through the server's checks: the review as the panel set it
  await publishOnPage(page, 2)
  expect(await latestTree(request, headers, id)).toMatchObject({
    next: { type: 'review', name: 'Boss', ...done },
  })
})

test('panel: a path condition and the default path, one undo step each; it publishes as the fork paths', async ({
  page,
  request,
}) => {
  const headers = { Authorization: await bearer(request) }
  const id = await bpmnModel(request, headers, 'e2e-bpmn-panel-paths', { amount: 'number' })
  await openDesign(page, id)
  await pad(page, shape(page, 'begin'), 'insert.exclusive-block')
  const { fork, paths } = blockAfter(await saved(page, id), 'begin')
  const [big, other] = paths as [string, string]
  const side = panel(page)

  // the first path: amount > 1000
  await select(flow(page, big))
  await showing(page, msg('wf.designer.drawer.path'))
  await side.getByRole('button', { name: msg('wf.designer.cond.addGroup') }).click()
  await side.getByRole('combobox', { name: msg('wf.designer.cond.op') }).click({ force: true })
  await page.getByRole('option', { name: msg('wf.designer.op.gt'), exact: true }).click()
  const value = side.getByRole('spinbutton', { name: msg('wf.designer.cond.value') })
  await value.fill('1000')
  await value.blur()
  const when = [[{ field: 'amount', op: 'gt', value: 1000 }]]
  let xml = await saved(page, id)
  expect(conditions(xml)).toEqual({ [big]: when })
  expect(gateways(xml)[fork]!.default).toBe(other)
  await expect(flow(page, big)).toHaveClass(/qw-cond/)

  // made the default path: its condition goes with it; one undo restores both
  const makeDefault = side.getByRole('button', { name: msg('wf.bpmn.panel.makeDefault') })
  await makeDefault.click()
  await expect(side).toContainText(msg('wf.designer.path.fallbackHint'))
  await expect(makeDefault).toHaveCount(0)
  xml = await saved(page, id)
  expect(conditions(xml)).toEqual({})
  expect(gateways(xml)[fork]!.default).toBe(big)
  await undo(page)
  await expect(makeDefault).toBeVisible()
  xml = await saved(page, id)
  expect(conditions(xml)).toEqual({ [big]: when })
  expect(gateways(xml)[fork]!.default).toBe(other)

  // the default path (a block's lower one: clicked on its bottom segment) has no such button
  const lower = (await flow(page, other).locator('.djs-visual > path').boundingBox())!
  await page.mouse.click(lower.x + lower.width / 2, lower.y + lower.height - 1)
  await showing(page, msg('wf.designer.drawer.path'))
  await expect(side).toContainText(msg('wf.designer.path.fallbackHint'))
  await expect(makeDefault).toHaveCount(0)

  await publishOnPage(page, 2)
  expect(await latestTree(request, headers, id)).toMatchObject({
    next: {
      id: fork,
      type: 'fork',
      mode: 'exclusive',
      paths: [
        { id: big, when },
        { id: other, fallback: true, when: [] },
      ],
    },
  })
})

test('panel: the path order and a new path, one undo step each', async ({ page, request }) => {
  const headers = { Authorization: await bearer(request) }
  const id = await bpmnModel(request, headers, 'e2e-bpmn-panel-order')
  await openDesign(page, id)
  await pad(page, shape(page, 'begin'), 'insert.exclusive-block')
  const { fork, join, paths } = blockAfter(await saved(page, id), 'begin')
  const [big, other] = paths as [string, string]
  const side = panel(page)
  const order = async () =>
    flows(await saved(page, id))
      .filter((f) => f.from === fork)
      .map((f) => f.id)
  const listed = () => side.getByRole('listitem')

  // the fork lists its paths in order, the default marked
  await select(shape(page, fork))
  await showing(page, msg('wf.bpmn.panel.fork'))
  await expect(listed()).toHaveText([
    new RegExp(`^1\\s*${big}$`),
    new RegExp(`^2\\s*${other}\\s*${msg('wf.bpmn.panel.default')}$`),
  ])
  // the default path up: first in the document; undo, redo
  await listed()
    .filter({ hasText: other })
    .getByRole('button', { name: msg('wf.bpmn.panel.up') })
    .click()
  await expect(listed().first()).toContainText(other)
  expect(await order()).toEqual([other, big])
  await undo(page)
  await expect(listed().first()).toContainText(big)
  expect(await order()).toEqual([big, other])
  await undo(page, true)
  expect(await order()).toEqual([other, big])

  // a new path: fork → join, last; selected to be set up; one undo takes it back
  await select(shape(page, fork))
  await side.getByRole('button', { name: msg('wf.designer.fork.addPath') }).click()
  await showing(page, msg('wf.designer.drawer.path'))
  const xml = await saved(page, id)
  const added = flows(xml).filter((f) => f.from === fork)
  expect(added.map((f) => f.id).slice(0, 2)).toEqual([other, big])
  expect(added).toHaveLength(3)
  expect(added[2]!.to).toBe(join)
  await undo(page)
  expect(await order()).toEqual([other, big])
})

test('panel: a copied and pasted review keeps its qw:Config', async ({ page, request }) => {
  const headers = { Authorization: await bearer(request) }
  const id = await bpmnModel(request, headers, 'e2e-bpmn-panel-paste')
  await openDesign(page, id)
  await appendReview(page, shape(page, 'begin'), 'Boss')
  await select(task(page, 'Boss'))
  await panel(page).getByText(msg('wf.designer.review.sign.all')).click()
  const config = { ...NEW_REVIEW, sign: 'all' }
  expect(settings(await saved(page, id))).toEqual([{ type: 'userTask', name: 'Boss', config }])

  // copied, pasted below (placed with a click on the empty canvas)
  await select(task(page, 'Boss'))
  await canvas(page).locator('.djs-container > svg').focus()
  await page.keyboard.press('ControlOrMeta+c')
  await page.keyboard.press('ControlOrMeta+v')
  const box = (await canvas(page).locator('.djs-container > svg').boundingBox())!
  const at = { x: box.x + box.width * 0.4, y: box.y + box.height - 80 }
  await page.mouse.move(at.x - 10, at.y - 10)
  await page.mouse.move(at.x, at.y)
  await page.mouse.click(at.x, at.y)
  await expect(task(page, 'Boss')).toHaveCount(2)
  expect(settings(await saved(page, id))).toEqual([
    { type: 'userTask', name: 'Boss', config },
    { type: 'userTask', name: 'Boss', config },
  ])
})

const EN = 'en-US'
type Texts = { [key: string]: string | Texts }
const leaves = (t: Texts): string[] =>
  Object.values(t).flatMap((v) => (typeof v === 'string' ? [v] : leaves(v)))
/** what the canvas may say in `lang`: the wf.bpmn texts `translate.ts` maps bpmn-js's templates to */
function canvasTexts(lang: string) {
  const file = new URL(`../src/locales/${lang}/wf.bpmn.json`, import.meta.url)
  const { wf } = JSON.parse(readFileSync(file, 'utf8')) as { wf: { bpmn: Texts } }
  return new Set(leaves({ ...wf.bpmn, panel: {} }))
}

/**
 * Every text the canvas's palette, context pad and popup menu show: labels, tooltips (`title`, `aria-label`)
 * and text; the bpmn.io logo and its notice are not among them (the license keeps them as they are).
 */
const canvasUi = (page: Page) =>
  canvas(page)
    .locator('.djs-palette, .djs-context-pad, .djs-popup')
    .evaluateAll((roots) =>
      roots.flatMap((root) =>
        [root, ...root.querySelectorAll('*')].flatMap((e) => [
          ...['title', 'aria-label', 'placeholder'].map((a) => e.getAttribute(a) ?? ''),
          ...[...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent!.trim()),
        ]),
      ),
    )
    .then((texts) => texts.filter(Boolean))

/** All the canvas shows (pad of `element`, its change menu, the palette) is in `lang`; how many texts. */
async function inLanguage(page: Page, element: Locator, lang: string) {
  await pad(page, element, 'replace')
  await expect(page.locator('.djs-popup')).toBeVisible()
  const texts = await canvasUi(page)
  const known = canvasTexts(lang)
  expect(texts.filter((t) => !known.has(t))).toEqual([])
  await closeMenu(page)
  return texts.length
}

test('i18n: the canvas speaks the app language, switched at runtime with the panel and the check', async ({
  page,
  request,
}) => {
  const headers = { Authorization: await bearer(request) }
  const id = await bpmnModel(request, headers, 'e2e-bpmn-i18n')
  await openDesign(page, id)
  // begin → Boss beside begin → end: the start has two ways out
  await appendReview(page, shape(page, 'begin'), 'Boss')
  await page.getByRole('button', { name: msg('wf.model.design.publish') }).click()
  const alert = canvas(page).getByRole('alert')
  const arity = (lang: string) => msg('validation.wf.bpmn_arity', lang).split('{node}')[0]!
  await expect(alert).toContainText(arity('zh-CN'))

  // palette (11 tools), the review's pad (9) and change menu (title, search, the carbon copy)
  const zh = await inLanguage(page, task(page, 'Boss'), 'zh-CN')
  expect(zh).toBeGreaterThanOrEqual(22)
  await showing(page, msg('wf.designer.drawer.review'))

  // switched in the header: palette, the open pad, the panel and the check messages follow, no reload
  await page.getByRole('button', { name: msg('common.layout.language') }).click()
  await page.getByRole('menuitem', { name: msg('common.language.enUS') }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', EN)
  await expect(
    canvas(page).locator('.djs-context-pad [data-action="append.user-task"]'),
  ).toHaveAttribute('title', msg('wf.bpmn.append.review', EN))
  expect(await inLanguage(page, task(page, 'Boss'), EN)).toBe(zh)
  await showing(page, msg('wf.designer.drawer.review', EN))
  await expect(alert).toContainText(arity(EN))
  await expect(alert).not.toContainText(arity('zh-CN'))
})

test.describe('in English, 1440 × 900', () => {
  test.use({ locale: EN, viewport: { width: 1440, height: 900 } })

  test('panel: the who-reviews choices neither overlap nor run out of the panel', async ({
    page,
    request,
  }) => {
    const headers = { Authorization: await bearer(request) }
    const id = await bpmnModel(request, headers, 'e2e-bpmn-panel-en')
    await openDesign(page, id)
    await expect(page.locator('html')).toHaveAttribute('lang', EN)
    await appendReview(page, shape(page, 'begin'), 'Boss')
    await select(task(page, 'Boss'))
    await showing(page, msg('wf.designer.drawer.review', EN))
    await kindsFit(panel(page), EN)
  })
})

test('csp: the designer, its menus and the watermark notice raise no CSP violation', async ({
  page,
  request,
}) => {
  const headers = { Authorization: await bearer(request) }
  const id = await bpmnModel(request, headers, 'e2e-bpmn-csp')
  await openDesign(page, id)
  // the change menu, the block helpers' icons, a review's panel (the `page` fixture fails on a violation)
  await pad(page, shape(page, 'begin'), 'insert.exclusive-block')
  const { fork } = blockAfter(await saved(page, id), 'begin')
  expect(await changeMenu(page, shape(page, fork))).toHaveLength(2)
  await closeMenu(page)
  await appendReview(page, shape(page, 'begin'), 'Boss')
  await select(task(page, 'Boss'))
  await showing(page, msg('wf.designer.drawer.review'))

  // the logo opens bpmn.io's notice as it is (no navigation); it closes on its backdrop
  const url = page.url()
  await canvas(page).locator('.bjs-powered-by').click()
  const notice = page.locator('.bjs-powered-by-lightbox')
  await expect(notice).toBeVisible()
  await expect(notice).toContainText('powered by bpmn.io')
  await notice.locator('.backdrop').click({ position: { x: 5, y: 5 } })
  await expect(notice).toHaveCount(0)
  expect(page.url()).toBe(url)
  expect(page.context().pages()).toHaveLength(1)
})

/** a computed transform that moves nothing */
const IDENTITY = ['none', 'matrix(1, 0, 0, 1, 0, 0)']

/**
 * The bpmn.io logo of the diagram on `page` (designer or read-only) is bpmn-js's, visible, on top and unaltered
 * one, hit where it is drawn (left, middle, right), its color, 53 × 21; from it up to the root
 * nothing dims, filters, clips, blends, moves or hides it; the plate lies under it; the screen over it is what
 * the logo and its plate alone show.
 */
async function logoIntact(page: Page) {
  const logo = canvas(page).locator('.bjs-powered-by')
  await expect(logo).toHaveCount(1)
  await expect(logo).toBeVisible()
  // the page's v-loading mask (z-index 2000) fades out for up to 0.4 s after its load, invisible but still hit
  await expect(page.locator('.el-loading-mask')).toHaveCount(0)
  // hit-tests and screenshots need it in the viewport
  await logo.scrollIntoViewIfNeeded()
  // (in the page: its globals through the logo's document, e2e code has no DOM types)
  const seen = await logo.evaluate((a) => {
    const doc = a.ownerDocument
    const style = (e: typeof a) => doc.defaultView.getComputedStyle(e)
    const svg = a.querySelector('svg')
    const box = svg.getBoundingClientRect()
    const y = box.top + box.height / 2
    const chain = []
    for (let e = svg; e; e = e.parentElement) {
      const s = style(e)
      chain.push({
        opacity: Number(s.opacity),
        filter: s.filter,
        clipPath: s.clipPath,
        blend: s.mixBlendMode,
        mask: s.maskImage,
        transform: s.transform,
        visibility: s.visibility,
      })
    }
    const plate = doc.querySelector('.wf-bpmn__plate')
    return {
      // the plate: its own element, under the logo in the logo's stacking context
      under:
        plate.parentElement.contains(a) && Number(style(plate).zIndex) < Number(style(a).zIndex),
      hits: [box.left + 3, box.left + box.width / 2, box.right - 3].map((x) =>
        a.contains(doc.elementFromPoint(x, y)),
      ),
      size: [box.width, box.height],
      color: style(a).color,
      fill: style(svg.querySelector('path')).fill,
      chain,
    }
  })
  expect(seen.under).toBe(true)
  expect(seen.hits).toEqual([true, true, true])
  expect(seen.color).toBe('rgb(64, 64, 64)')
  expect(seen.fill).toBe('rgb(64, 64, 64)')
  expect(Math.abs(seen.size[0]! - 53)).toBeLessThanOrEqual(1)
  expect(Math.abs(seen.size[1]! - 21)).toBeLessThanOrEqual(1)
  expect(seen.chain.reduce((p, s) => p * s.opacity, 1)).toBe(1)
  for (const s of seen.chain) {
    expect(s).toMatchObject({ filter: 'none', clipPath: 'none', blend: 'normal', mask: 'none' })
    expect(s.visibility).toBe('visible')
    expect(IDENTITY).toContain(s.transform)
  }

  // the plate lies under the whole logo
  const box = (await logo.locator('svg').boundingBox())!
  const plate = (await canvas(page).locator('.wf-bpmn__plate').boundingBox())!
  expect(plate.x).toBeLessThan(box.x)
  expect(plate.y).toBeLessThan(box.y)
  expect(plate.x + plate.width).toBeGreaterThan(box.x + box.width)
  expect(plate.y + plate.height).toBeGreaterThan(box.y + box.height)

  // the screen over the logo is what the logo and its plate alone show: everything else hidden for one shot,
  // pseudo-elements too (an overlay letting clicks through, which elementFromPoint misses, would differ);
  // then the logo too: the plate alone looks different (the logo shows on it)
  const shot = () => page.screenshot({ clip: box, animations: 'disabled', caret: 'hide' })
  const before = await shot()
  const hide = await logo.evaluateHandle((a) => {
    const doc = a.ownerDocument
    const keep = new Set<unknown>([a, ...a.querySelectorAll('*')])
    for (let e = a.parentElement; e; e = e.parentElement) keep.add(e)
    for (const e of doc.querySelectorAll('.wf-bpmn__plate')) keep.add(e)
    const undo: (() => void)[] = []
    const off = (e: typeof a) => {
      // Attribute changes make el-watermark replace its layer with a visible one.
      if (e.matches('.app-layout > div[style*="background-image:"]')) return
      const value = e.style.getPropertyValue('visibility')
      const priority = e.style.getPropertyPriority('visibility')
      undo.unshift(() => e.style.setProperty('visibility', value, priority))
      e.style.setProperty('visibility', 'hidden', 'important')
    }
    const pseudo = new doc.defaultView.CSSStyleSheet()
    pseudo.replaceSync(
      '*::before, *::after, .app-layout > div[style*="background-image:"] { visibility: hidden !important; }',
    )
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, pseudo]
    for (const e of doc.querySelectorAll('body *')) if (!keep.has(e)) off(e)
    return {
      logo: () => off(a),
      undo: () => {
        for (const fn of undo) fn()
        doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s: unknown) => s !== pseudo)
      },
    }
  })
  const alone = await shot()
  await hide.evaluate((h) => h.logo())
  const plateOnly = await shot()
  await hide.evaluate((h) => h.undo())
  expect(alone.equals(before), 'the logo region differs from the logo and its plate alone').toBe(
    true,
  )
  expect(plateOnly.equals(before), 'the logo does not show on its plate').toBe(false)
  await expect(logo).toBeVisible()
}

/** Check the actual watermark ink and its stacking even when no tile ink crosses the logo. */
async function applicationLogoIntact(page: Page) {
  const layer = page.locator('.app-layout > div[style*="background-image:"]')
  await expect(layer).toBeVisible()
  await expect
    .poll(() =>
      layer.evaluate(async (e) => {
        const doc = e.ownerDocument
        const image = new doc.defaultView.Image()
        image.src = doc.defaultView.getComputedStyle(e).backgroundImage.slice(5, -2)
        await image.decode()
        const canvas = doc.createElement('canvas')
        canvas.width = image.width
        canvas.height = image.height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(image, 0, 0)
        return ctx
          .getImageData(0, 0, image.width, image.height)
          .data.some((v: number, i: number) => i % 4 === 3 && v > 0)
      }),
    )
    .toBe(true)
  await logoIntact(page)
  const seen = await canvas(page).evaluate((e) => {
    const doc = e.ownerDocument
    // A stylesheet leaves the layer's attributes untouched, so its observer cannot replace it.
    const sheet = new doc.defaultView.CSSStyleSheet()
    sheet.replaceSync(
      '.app-layout > div[style*="background-image:"] { pointer-events: auto !important; }',
    )
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet]
    try {
      const logo = e.querySelector('.bjs-powered-by')
      const box = logo.querySelector('svg').getBoundingClientRect()
      const area = e.querySelector('.djs-container').getBoundingClientRect()
      const layer = doc.querySelector('.app-layout > div[style*="background-image:"]')
      return {
        logo: [box.left + 3, box.left + box.width / 2, box.right - 3].map((x) =>
          logo.contains(doc.elementFromPoint(x, box.top + box.height / 2)),
        ),
        canvas: doc.elementFromPoint(area.left + area.width / 2, area.bottom - 60) === layer,
      }
    } finally {
      doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s: unknown) => s !== sheet)
    }
  })
  expect(seen.canvas, 'the app watermark participates in the canvas hit-test').toBe(true)
  expect(seen.logo, 'the app watermark must stay below the whole bpmn.io logo').toEqual([
    true,
    true,
    true,
  ])
}

for (const scheme of ['light', 'dark'] as const)
  for (const mode of ['side', 'top', 'mix'] as const)
    test(`watermark: application watermark leaves designer and viewer logos intact (${scheme}, ${mode})`, async ({
      page,
      request,
    }) => {
      await page.emulateMedia({ colorScheme: scheme })
      const root = { Authorization: await bearer(request) }
      const key = `e2e-bpmn-app-logo-${scheme}-${mode}`
      const id = await bpmnModel(request, root, key)
      await openDesign(page, id)
      await page.getByRole('button', { name: msg('layout.settings.title') }).click()
      const settings = page.getByRole('dialog', { name: msg('layout.settings.title') })
      await settings.getByText(msg('layout.settings.watermark'), { exact: true }).click()
      await expect(
        settings.getByRole('switch', { name: msg('layout.settings.watermark') }),
      ).toBeChecked()
      await settings
        .getByRole('radio', { name: msg(`layout.settings.layouts.${mode}`) })
        .check({ force: true })
      await page.keyboard.press('Escape')
      await expect(settings).toBeHidden()
      await select(shape(page, 'begin'))
      await showing(page, msg('wf.designer.drawer.begin'))
      await applicationLogoIntact(page)
      if (mode !== 'top') {
        await page.getByRole('button', { name: msg('common.layout.collapse') }).click()
        await expect(page.locator('.el-menu--collapse')).toBeVisible()
        await applicationLogoIntact(page)
      }

      const tree = reviewTree(await userId(request, root, USERS.admin.username))
      const instance = await bpmnInstance(request, root, `${key}-view`, tree)
      await signIn(page, 'staff', `/workflow/instances/${instance}`)
      await expect.poll(() => markOf(page, 'first')).toBe('active')
      await applicationLogoIntact(page)
      await page.emulateMedia({ media: 'print' })
      await applicationLogoIntact(page)
    })

for (const scheme of ['light', 'dark'] as const)
  test(`watermark: the bpmn.io logo is visible, on top and unaltered beside the open panel (${scheme})`, async ({
    page,
    request,
  }) => {
    await page.emulateMedia({ colorScheme: scheme })
    const headers = { Authorization: await bearer(request) }
    const id = await bpmnModel(request, headers, `e2e-bpmn-logo-${scheme}`)
    await openDesign(page, id)
    const html = expect(page.locator('html'))
    await (scheme === 'dark' ? html : html.not).toHaveClass(/\bdark\b/)
    await select(shape(page, 'begin'))
    await showing(page, msg('wf.designer.drawer.begin'))

    await logoIntact(page)
    await expect(shape(page, 'begin')).toBeVisible()
  })

/** begin → first → route (amount > 1000: finance | else: –) → both (left: l ∥ right: r) → last, `admin` reviews */
function reviewTree(admin: number) {
  const review = (id: string, next?: object) => ({
    ...REVIEW,
    id,
    type: 'review',
    name: `E2E ${id}`,
    assignee: { kind: 'users', ids: [admin] },
    next,
  })
  const path = (id: string, child?: object, extra: object = {}) => ({
    id,
    name: `E2E ${id}`,
    when: [],
    child,
    ...extra,
  })
  return {
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
  } as Parameters<typeof treeToXml>[0]
}

/** A BPMN model `key` published as `tree` (field amount) and started by staff with amount 5; the instance id. */
async function bpmnInstance(
  request: APIRequestContext,
  headers: Record<string, string>,
  key: string,
  tree: Parameters<typeof treeToXml>[0],
) {
  const id = await bpmnModel(request, headers, key)
  const v1 = await request.post(`/api/wf/models/${id}/versions`, {
    headers,
    data: { xml: treeToXml(tree), fields: { amount: 'number' } },
  })
  expect(v1.ok(), await v1.text()).toBe(true)
  const started = await request.post('/api/wf/instances', {
    headers: { Authorization: await bearer(request, USERS.staff) },
    data: { modelKey: key, formValues: { amount: 5 } },
  })
  expect(started.status(), await started.text()).toBe(201)
  return ((await started.json()) as { data: { id: number } }).data.id
}

/** `headers`' holder approves their oldest pending task on instance `id` */
async function approve(request: APIRequestContext, headers: Record<string, string>, id: number) {
  const res = await request.get(`/api/wf/instances/${id}`, { headers })
  const [task] = ((await res.json()) as { data: { myTasks: { id: number }[] } }).data.myTasks
  const done = await request.post(`/api/wf/tasks/${task!.id}/approve`, { headers, data: {} })
  expect(done.ok(), await done.text()).toBe(true)
}

/** the progress element `id` shows on the read-only diagram (its `qw-*` marker), else undefined */
const markOf = (page: Page, id: string) =>
  canvas(page)
    .locator(`.djs-element[data-element-id="${id}"]`)
    .evaluate((e) =>
      [...e.classList].find((c) => /^qw-(done|active|stopped|skipped)$/.test(c))?.slice(3),
    )

test('viewer: a BPMN instance shows its diagram marked by its progress, joins and inner flows filled in', async ({
  page,
  request,
}) => {
  const root = { Authorization: await bearer(request) }
  const tree = reviewTree(await userId(request, root, USERS.admin.username))
  const xml = treeToXml(tree)
  const id = await bpmnInstance(request, root, 'e2e-bpmn-view', tree)
  await approve(request, root, id)
  // the detail's progress names an element the diagram lacks first: skipped, the rest still marked
  await page.route(new RegExp(`/api/wf/instances/${id}$`), async (route) => {
    const res = await route.fetch()
    const body = (await res.json()) as { data: { progress: Record<string, string> } }
    body.data.progress = { ghost: 'active', ...body.data.progress }
    await route.fulfill({ response: res, json: body })
  })
  await signIn(page, 'staff', `/workflow/instances/${id}`)
  const card = page.locator('.wf-detail__diagram')
  await expect(card).toContainText(msg('wf.center.detail.progress'))
  await expect(page.locator('.wf-detail__progress')).toHaveCount(0)

  const all = flows(xml)
  const out = (from: string) => all.find((f) => f.from === from)!
  const [j1, j2] = [out('finance').to, out('l').to]
  const expectMarks = async (want: Record<string, string | undefined>) => {
    for (const [el, mark] of Object.entries(want)) expect(await markOf(page, el), el).toBe(mark)
  }
  await expect.poll(() => markOf(page, 'first')).toBe('done')
  await expectMarks({
    begin: 'done',
    [out('begin').id]: 'done',
    first: 'done',
    [out('first').id]: 'done',
    route: 'done',
    // the path not taken grey to its join; the one taken (empty) lit, its join with it
    big: 'skipped',
    finance: 'skipped',
    [out('finance').id]: 'skipped',
    small: 'done',
    [j1]: 'done',
    // both paths active: their first flows lit, nothing past the active steps
    [out(j1).id]: undefined,
    both: 'active',
    left: 'done',
    l: 'active',
    right: 'done',
    r: 'active',
    [out('l').id]: undefined,
    [j2]: undefined,
    [out(j2).id]: undefined,
    last: undefined,
    [out('last').id]: undefined,
  })
  await expect(flow(page, 'big')).toHaveClass(/\bqw-cond\b/)
  for (const plain of ['small', out('begin').id])
    await expect(flow(page, plain)).not.toHaveClass(/\bqw-cond\b/)
  await expect(card.locator('.wf-bpmn-viewer__legend li')).toHaveText(
    ['done', 'active', 'skipped'].map((p) => msg(`wf.designer.progress.${p}`)),
  )

  // l, r and last approved: the whole line lit up to the end, the path not taken still grey
  for (let i = 0; i < 3; i++) await approve(request, root, id)
  await page.reload()
  await expect.poll(() => markOf(page, 'last')).toBe('done')
  await expectMarks({
    both: 'done',
    l: 'done',
    [out('l').id]: 'done',
    [j2]: 'done',
    [out(j2).id]: 'done',
    [out('last').id]: 'done',
    [out('finance').id]: 'skipped',
  })
  await expect(card.locator('.wf-bpmn-viewer__legend li')).toHaveText(
    ['done', 'skipped'].map((p) => msg(`wf.designer.progress.${p}`)),
  )
})

for (const scheme of ['light', 'dark'] as const)
  test(`watermark: the bpmn.io logo on the read-only diagram is intact, in print too (${scheme})`, async ({
    page,
    request,
  }) => {
    await page.emulateMedia({ colorScheme: scheme })
    const root = { Authorization: await bearer(request) }
    const tree = reviewTree(await userId(request, root, USERS.admin.username))
    const id = await bpmnInstance(request, root, `e2e-bpmn-view-logo-${scheme}`, tree)
    await signIn(page, 'staff', `/workflow/instances/${id}`)
    await expect.poll(() => markOf(page, 'first')).toBe('active')
    const html = expect(page.locator('html'))
    await (scheme === 'dark' ? html : html.not).toHaveClass(/\bdark\b/)
    await logoIntact(page)

    // the print style keeps the diagram and its logo (the action bar goes)
    const print = page.getByRole('button', { name: msg('wf.center.detail.print') })
    await page.emulateMedia({ media: 'print' })
    await expect(print).toBeHidden()
    await logoIntact(page)
    await page.emulateMedia({ media: 'screen' })
    await expect(print).toBeVisible()

    // the logo opens bpmn.io's notice as it is (no navigation); it closes on its backdrop
    const url = page.url()
    await canvas(page).locator('.bjs-powered-by').click()
    const notice = page.locator('.bjs-powered-by-lightbox')
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('powered by bpmn.io')
    await notice.locator('.backdrop').click({ position: { x: 5, y: 5 } })
    await expect(notice).toHaveCount(0)
    expect(page.url()).toBe(url)
  })
