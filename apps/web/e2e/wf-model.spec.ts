import { readFile } from 'node:fs/promises'
import type { Locator } from '@playwright/test'
import { USERS } from './env.ts'
import {
  bearer,
  currentPage,
  expect,
  msg,
  publishModel,
  signIn,
  test,
  userId,
  type Page,
} from './fixtures.ts'

// 模型管理: the models grouped by category, add / edit (start scope, managers,
// cancel / withdraw switches), enable / disable, move within the category, the versions of a published
// model, delete one never published. The design page (draft, publish refused with the errors on the
// nodes, publish with the fields), a custom model's view component and its designer without field access;
// leaving with unsaved changes asks, the kept-alive list reloads when back.
// A version exported as JSON, a JSON imported as the next version (the server's check). Root holds every
// wfPerms.model action.

/** dict label (seeded in the database, not in the locale files) */
const FINANCE = '财务'
const PUBLISHED = 'E2E Model Published'
const ADDED = 'E2E Model Added'
const RENAMED = 'E2E Model Renamed'

const field = (prop: string) => msg(`field.wf.model.${prop}`)
const body = (page: Page) => page.locator('.qw-table-panel .el-table__body')
const row = (page: Page, name: string) => body(page).locator('tr').filter({ hasText: name })
/** the rows' texts in the order shown */
const names = async (page: Page) => (await body(page).locator('tr').allInnerTexts()).join('\n')

/** Clicks the el-switch labelled `name` in `scope` (its input is visually hidden). */
const flip = (scope: Locator, name: string) =>
  scope
    .locator('.el-switch')
    .filter({ has: scope.page().getByRole('switch', { name }) })
    .click()

test('list: add, edit, enable, move within the category, versions, delete', async ({
  page,
  request,
}) => {
  const headers = { Authorization: await bearer(request) }
  const root = await userId(request, headers, USERS.admin.username)
  await publishModel(
    request,
    headers,
    { modelKey: 'e2e-model-published', name: PUBLISHED },
    {
      id: 'begin',
      type: 'begin',
      name: 'Begin',
      next: {
        id: 'boss',
        type: 'review',
        name: 'Boss',
        assignee: { kind: 'users', ids: [root] },
        sign: 'any',
        whenNobody: 'autoPass',
        whenInitiatorIsReviewer: 'self',
        onReject: 'finish',
      },
    },
  )
  const roles = (await (await request.get('/api/iam/roles/options', { headers })).json()) as {
    data: { id: number; code: string }[]
  }
  const staffRole = roles.data.find((r) => r.code === 'staff')!.id

  await signIn(page, 'admin', '/wf/models')
  await expect(currentPage(page, 'menu.wf.model')).toBeVisible()
  await expect(row(page, PUBLISHED)).toContainText(FINANCE)

  // add a finance model: roles may start it, approvers may not withdraw
  await page.getByRole('button', { name: msg('crud.action.create'), exact: true }).click()
  const create = page.getByRole('dialog', {
    name: msg('crud.title.create', 'zh-CN', { name: msg('wf.model.entity') }),
  })
  await create.getByRole('textbox', { name: field('modelKey') }).fill('e2e-model-added')
  await create.getByRole('textbox', { name: field('name') }).fill(ADDED)
  await create.getByRole('combobox', { name: field('category') }).click({ force: true })
  await page.getByRole('option', { name: FINANCE, exact: true }).click()
  // below the fold: the select itself scrolled into view (a forced click on its input lands off screen)
  await create
    .locator('.el-select')
    .filter({ has: page.getByRole('combobox', { name: field('roleIds') }) })
    .click()
  await page.getByRole('option', { name: msg('seed.role.staff'), exact: true }).click()
  await flip(create, field('allowWithdraw'))
  const created = page.waitForRequest(
    (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/wf/models',
  )
  await create.getByRole('button', { name: msg('crud.action.save') }).click()
  expect((await created).postDataJSON()).toMatchObject({
    modelKey: 'e2e-model-added',
    name: ADDED,
    category: 'finance',
    formKind: 'dynamic',
    initiatorScope: { userIds: [], deptIds: [], roleIds: [staffRole] },
    managerUserIds: [],
    allowCancel: true,
    allowWithdraw: false,
  })
  await expect(create).toBeHidden()

  // one finance group: the newer model first (same sort number), then the published one
  const added = row(page, ADDED)
  await expect(added).toBeVisible()
  const text = await names(page)
  expect(text.indexOf(ADDED)).toBeLessThan(text.indexOf(PUBLISHED))
  await expect(row(page, PUBLISHED).locator('td').first()).not.toContainText(FINANCE)
  await expect(row(page, PUBLISHED)).toContainText(msg('wf.model.list.yes'))
  await expect(added).toContainText(msg('wf.model.list.no'))

  // move the added model down, below the published one
  const moveDown = msg('wf.model.list.moveDown', 'zh-CN', { name: ADDED })
  const sorted = page.waitForRequest((r) => r.url().endsWith('/api/wf/models/sort'))
  await added.getByRole('button', { name: moveDown }).click()
  const items = ((await sorted).postDataJSON() as { items: { id: number }[] }).items
  expect(items.length).toBeGreaterThanOrEqual(2)
  await expect
    .poll(async () => {
      const t = await names(page)
      return t.indexOf(PUBLISHED) < t.indexOf(ADDED)
    })
    .toBe(true)

  // edit: the key stays, the scope and switches come back as saved
  await added.getByRole('button', { name: msg('crud.action.edit') }).click()
  const edit = page.getByRole('dialog', {
    name: msg('crud.title.edit', 'zh-CN', { name: msg('wf.model.entity') }),
  })
  await expect(edit.getByRole('textbox', { name: field('modelKey') })).toHaveValue(
    'e2e-model-added',
  )
  await expect(edit.getByRole('textbox', { name: field('modelKey') })).toBeDisabled()
  await expect(edit.getByRole('switch', { name: field('allowWithdraw') })).not.toBeChecked()
  await expect(edit).toContainText(msg('seed.role.staff'))
  await edit.getByRole('textbox', { name: field('name') }).fill(RENAMED)
  const updated = page.waitForRequest(
    (r) => r.method() === 'PUT' && /\/api\/wf\/models\/\d+$/.test(r.url()),
  )
  await edit.getByRole('button', { name: msg('crud.action.save') }).click()
  expect((await updated).postDataJSON()).toMatchObject({
    name: RENAMED,
    initiatorScope: { roleIds: [staffRole] },
    allowWithdraw: false,
  })
  await expect(edit).toBeHidden()
  const renamed = row(page, RENAMED)
  await expect(renamed).toBeVisible()

  // disable it
  const enabled = renamed.getByRole('switch')
  await expect(enabled).toBeChecked()
  await renamed.locator('.el-switch').click()
  await expect(enabled).not.toBeChecked()

  // the published model's versions: v1, current
  await row(page, PUBLISHED)
    .getByRole('button', { name: msg('wf.model.list.versions') })
    .click()
  const versions = page.getByRole('dialog', {
    name: msg('wf.model.versions.title', 'zh-CN', { name: PUBLISHED }),
  })
  await expect(versions.locator('.el-table__body tr')).toHaveCount(1)
  await expect(versions).toContainText('v1')
  await expect(versions).toContainText(msg('wf.model.versions.current'))
  await page.keyboard.press('Escape')
  await expect(versions).toBeHidden()

  // only a model never published can be deleted
  await expect(
    row(page, PUBLISHED).getByRole('button', { name: msg('crud.action.delete') }),
  ).toHaveCount(0)
  await renamed.getByRole('button', { name: msg('crud.action.delete') }).click()
  await page
    .getByRole('dialog', { name: msg('crud.confirm.title') })
    .getByRole('button', { name: msg('crud.action.delete') })
    .click()
  await expect(renamed).toHaveCount(0)
})

/** begin → Boss (a review by `reviewer`) */
const bossFlow = (reviewer: number) => ({
  id: 'begin',
  type: 'begin',
  name: 'Begin',
  next: {
    id: 'boss',
    type: 'review',
    name: 'Boss',
    assignee: { kind: 'users', ids: [reviewer] },
    sign: 'any',
    whenNobody: 'autoPass',
    whenInitiatorIsReviewer: 'self',
    onReject: 'finish',
  },
})
const DESIGNED = 'E2E Model Designed'

test('design: draft saved as it is, publish refused with the errors on the nodes, then published with the fields', async ({
  page,
  request,
}) => {
  const headers = { Authorization: await bearer(request) }
  const root = await userId(request, headers, USERS.admin.username)
  // a dynamic model without a bound form: v1 published through the API with its fields
  const created = await request.post('/api/wf/models', {
    headers,
    data: {
      modelKey: 'e2e-model-design',
      name: DESIGNED,
      formKind: 'dynamic',
      category: 'finance',
    },
  })
  expect(created.ok(), await created.text()).toBe(true)
  const { id } = ((await created.json()) as { data: { id: number } }).data
  const v1 = await request.post(`/api/wf/models/${id}/versions`, {
    headers,
    data: { tree: bossFlow(root), fields: { amount: 'number' } },
  })
  expect(v1.ok(), await v1.text()).toBe(true)

  await signIn(page, 'admin', '/wf/models')
  await row(page, DESIGNED)
    .getByRole('button', { name: msg('wf.model.list.design') })
    .click()
  await expect(page).toHaveURL(new RegExp(`/wf/models/${id}/design$`))
  await expect(currentPage(page, 'menu.wf.modelDesign')).toBeVisible()
  await expect(
    page.getByText(msg('wf.model.design.current', 'zh-CN', { version: 1 })),
  ).toBeVisible()
  const designer = page.locator('.wf-designer')
  const reviews = designer.locator('.wf-card--review')
  await expect(reviews).toHaveCount(1)
  await expect(reviews.first()).toContainText('Boss')

  // a dynamic form's node has the field access table, over the last version's fields
  const drawer = page.locator('.wf-node-drawer')
  await reviews.first().locator('.wf-card__main').click()
  await expect(drawer.locator('.wf-access')).toBeVisible()
  await expect(drawer.locator('.wf-access')).toContainText('amount')
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()

  // a review step after Boss, its reviewers not picked yet: saved as it is
  await designer
    .getByRole('button', { name: msg('wf.designer.add') })
    .last()
    .click()
  await page.getByRole('menuitem', { name: msg('wf.designer.type.review') }).click()
  await expect(reviews).toHaveCount(2)
  const saved = page.waitForRequest(
    (r) => r.method() === 'PUT' && r.url().endsWith(`/api/wf/models/${id}/draft`),
  )
  await page.getByRole('button', { name: msg('wf.model.design.saveDraft') }).click()
  const draft = ((await saved).postDataJSON() as { tree: { next: { next: object } } }).tree
  expect(draft.next.next).toMatchObject({ type: 'review', assignee: { kind: 'users', ids: [] } })
  await expect(page.getByText(msg('wf.model.design.draftSaved'))).toBeVisible()

  // publish refused before any request: the error names the step, its card is marked
  const publishes: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith(`/api/wf/models/${id}/versions`))
      publishes.push(r.url())
  })
  const publish = page.getByRole('button', { name: msg('wf.model.design.publish') })
  await publish.click()
  const node = msg('wf.designer.check.quote', 'zh-CN', { name: msg('wf.designer.type.review') })
  await expect(designer.getByRole('alert')).toContainText(
    msg('validation.wf.assignee_ids', 'zh-CN', { node }),
  )
  await expect(designer.locator('.wf-card.is-error')).toHaveCount(1)
  await expect(reviews.nth(1)).toHaveClass(/is-error/)
  expect(publishes).toEqual([])

  // the draft comes back after a reload; the initiator reviews the new step
  await page.reload()
  await expect(reviews).toHaveCount(2)
  await reviews.nth(1).locator('.wf-card__main').click()
  await drawer.getByText(msg('wf.designer.assignee.kinds.initiator'), { exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()

  // published as v2 with the fields (the version's snapshot)
  const published = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url().endsWith(`/api/wf/models/${id}/versions`),
  )
  await publish.click()
  await page
    .getByRole('dialog', { name: msg('wf.model.design.confirmTitle') })
    .getByRole('button', { name: msg('wf.model.design.publish') })
    .click()
  expect((await published).postDataJSON()).toMatchObject({
    tree: { next: { id: 'boss', next: { type: 'review', assignee: { kind: 'initiator' } } } },
    fields: { amount: 'number' },
  })
  await expect(
    page.getByText(msg('wf.model.design.published', 'zh-CN', { version: 2 })),
  ).toBeVisible()
  await expect(
    page.getByText(msg('wf.model.design.current', 'zh-CN', { version: 2 })),
  ).toBeVisible()
  const versions = (await (
    await request.get(`/api/wf/models/${id}/versions`, { headers })
  ).json()) as { data: { version: number; formSnapshot: object }[] }
  expect(versions.data[0]).toMatchObject({
    version: 2,
    formSnapshot: { fields: { amount: 'number' } },
  })
})

const LEAVING = 'E2E Model Leaving'

test('design: unsaved changes ask before leaving; a version published there shows on the list when back', async ({
  page,
  request,
}) => {
  const headers = { Authorization: await bearer(request) }
  const root = await userId(request, headers, USERS.admin.username)
  const created = await request.post('/api/wf/models', {
    headers,
    data: {
      modelKey: 'e2e-model-leaving',
      name: LEAVING,
      formKind: 'dynamic',
      category: 'finance',
    },
  })
  expect(created.ok(), await created.text()).toBe(true)
  const { id } = ((await created.json()) as { data: { id: number } }).data
  const draft = await request.put(`/api/wf/models/${id}/draft`, {
    headers,
    data: { tree: bossFlow(root) },
  })
  expect(draft.ok(), await draft.text()).toBe(true)

  await signIn(page, 'admin', '/wf/models')
  const listed = row(page, LEAVING)
  await expect(listed).toContainText(msg('wf.model.list.no'))
  const design = listed.getByRole('button', { name: msg('wf.model.list.design') })
  await design.click()
  const url = new RegExp(`/wf/models/${id}/design$`)
  await expect(page).toHaveURL(url)
  const designer = page.locator('.wf-designer')
  const notify = designer.locator('.wf-card--notify')
  await expect(designer.locator('.wf-card--review')).toHaveCount(1)

  // an unsaved step: back asks; cancel stays, confirming leaves without it
  await designer
    .getByRole('button', { name: msg('wf.designer.add') })
    .last()
    .click()
  await page.getByRole('menuitem', { name: msg('wf.designer.type.notify') }).click()
  await expect(notify).toHaveCount(1)
  const back = page.getByRole('button', { name: msg('wf.model.design.back') })
  const leave = page.getByRole('dialog', { name: msg('wf.model.design.leaveTitle') })
  await back.click()
  await leave.getByRole('button', { name: msg('common.action.cancel') }).click()
  await expect(leave).toBeHidden()
  await expect(page).toHaveURL(url)
  await expect(notify).toHaveCount(1)
  await back.click()
  await leave.getByRole('button', { name: msg('wf.model.design.leave') }).click()
  await expect(page).toHaveURL(/\/wf\/models$/)

  // published on the design page (the stored draft): back without asking, the kept-alive list reloaded
  await design.click()
  await expect(page).toHaveURL(url)
  await expect(designer.locator('.wf-card--review')).toHaveCount(1)
  await expect(notify).toHaveCount(0)
  await page.getByRole('button', { name: msg('wf.model.design.publish') }).click()
  await page
    .getByRole('dialog', { name: msg('wf.model.design.confirmTitle') })
    .getByRole('button', { name: msg('wf.model.design.publish') })
    .click()
  await expect(
    page.getByText(msg('wf.model.design.current', 'zh-CN', { version: 1 })),
  ).toBeVisible()
  await back.click()
  await expect(page).toHaveURL(/\/wf\/models$/)
  await expect(listed).toContainText(msg('wf.model.list.yes'))
  await expect(listed.getByRole('button', { name: msg('crud.action.delete') })).toHaveCount(0)
})

test('design: a custom model names an existing view component; its designer has no field access table', async ({
  page,
}) => {
  await signIn(page, 'admin', '/wf/models')
  await page.getByRole('button', { name: msg('crud.action.create'), exact: true }).click()
  const create = page.getByRole('dialog', {
    name: msg('crud.title.create', 'zh-CN', { name: msg('wf.model.entity') }),
  })
  await create.getByRole('textbox', { name: field('modelKey') }).fill('e2e-model-custom')
  await create.getByRole('textbox', { name: field('name') }).fill('E2E Model Custom')
  await create.getByText(msg('wf.model.formKinds.custom'), { exact: true }).click()
  await create.getByRole('textbox', { name: field('createRoute') }).fill('/biz/leave/new')
  const view = create.getByRole('textbox', { name: field('viewComponent') })
  await view.fill('biz/leave/missing')
  await create.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(
    create.getByText(msg('wf.model.form.noView', 'zh-CN', { path: 'biz/leave/missing' })),
  ).toBeVisible()
  await view.fill('biz/leave/view')
  const saved = page.waitForRequest(
    (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/wf/models',
  )
  await create.getByRole('button', { name: msg('crud.action.save') }).click()
  expect((await saved).postDataJSON()).toMatchObject({
    formKind: 'custom',
    createRoute: '/biz/leave/new',
    viewComponent: 'biz/leave/view',
  })
  await expect(create).toBeHidden()

  // the seeded leave model: a custom form decides what can be edited itself
  await row(page, msg('seed.wf.leave'))
    .getByRole('button', { name: msg('wf.model.list.design') })
    .click()
  const begin = page.locator('.wf-designer .wf-card--begin')
  await expect(begin).toContainText(msg('seed.wf.node.begin'))
  await begin.locator('.wf-card__main').click()
  const drawer = page.locator('.wf-node-drawer')
  await expect(drawer.getByRole('textbox', { name: msg('wf.designer.drawer.name') })).toBeVisible()
  // rendered (the designer's), not shown
  await expect(drawer.locator('.wf-access')).toHaveCount(1)
  await expect(drawer.locator('.wf-access')).toBeHidden()
})

const JSON_MODEL = 'E2E Model Json'

test('json: a version exported as a file, imported back as the next version; a broken or refused JSON publishes nothing', async ({
  page,
  request,
}) => {
  const headers = { Authorization: await bearer(request) }
  const root = await userId(request, headers, USERS.admin.username)
  const created = await request.post('/api/wf/models', {
    headers,
    data: {
      modelKey: 'e2e-model-json',
      name: JSON_MODEL,
      formKind: 'dynamic',
      category: 'finance',
    },
  })
  expect(created.ok(), await created.text()).toBe(true)
  const { id } = ((await created.json()) as { data: { id: number } }).data
  const v1 = await request.post(`/api/wf/models/${id}/versions`, {
    headers,
    data: { tree: bossFlow(root), fields: { amount: 'number' } },
  })
  expect(v1.ok(), await v1.text()).toBe(true)

  await signIn(page, 'admin', '/wf/models')
  await row(page, JSON_MODEL)
    .getByRole('button', { name: msg('wf.model.list.versions') })
    .click()
  const versions = page.getByRole('dialog', {
    name: msg('wf.model.versions.title', 'zh-CN', { name: JSON_MODEL }),
  })
  const rows = versions.locator('.el-table__body tr')
  await expect(rows).toHaveCount(1)

  // v1 exported: its tree and the fields it was published with
  const downloading = page.waitForEvent('download')
  await rows
    .first()
    .getByRole('button', { name: msg('wf.model.versions.exportJson') })
    .click()
  const file = await downloading
  expect(file.suggestedFilename()).toBe('e2e-model-json-v1.json')
  const exported = JSON.parse(await readFile(await file.path(), 'utf8')) as {
    tree: { next: { name: string } }
  }
  expect(exported).toMatchObject({
    modelKey: 'e2e-model-json',
    version: 1,
    tree: { id: 'begin', next: { id: 'boss', assignee: { kind: 'users', ids: [root] } } },
    fields: { amount: 'number' },
  })

  const publishes: object[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith(`/api/wf/models/${id}/versions`))
      publishes.push(r.postDataJSON() as object)
  })
  const input = versions.locator('input[type=file]')
  const pick = (text: string) =>
    input.setInputFiles({
      name: 'flow.json',
      mimeType: 'application/json',
      buffer: Buffer.from(text),
    })
  const confirmImport = async () => {
    const box = page.getByRole('dialog', { name: msg('wf.model.versions.importTitle') })
    await box.getByRole('button', { name: msg('wf.model.design.publish') }).click()
    // gone before the next import asks again
    await expect(box).toBeHidden()
  }

  // not a process JSON: refused in the page
  await pick('{"fields":{}}')
  await expect(page.getByText(msg('wf.model.versions.badJson'))).toBeVisible()
  expect(publishes).toEqual([])

  // the export with its step renamed: published as v2 with the file's fields
  exported.tree.next.name = 'Boss imported'
  await pick(JSON.stringify(exported))
  await confirmImport()
  await expect(
    page.getByText(msg('wf.model.design.published', 'zh-CN', { version: 2 })),
  ).toBeVisible()
  expect(publishes).toEqual([{ tree: exported.tree, fields: { amount: 'number' } }])
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText('v2')
  await expect(rows.first()).toContainText(msg('wf.model.versions.current'))
  await expect(rows.nth(1)).not.toContainText(msg('wf.model.versions.current'))

  // the server's check refuses a fork without a fallback path: its words shown, nothing published
  const fork = {
    id: 'begin',
    type: 'begin',
    name: 'Begin',
    next: {
      id: 'f1',
      type: 'fork',
      name: 'Amount',
      paths: [
        { id: 'big', name: 'Big', when: [[{ field: 'amount', op: 'gt', value: 1000 }]] },
        { id: 'small', name: 'Small', when: [[{ field: 'amount', op: 'lte', value: 1000 }]] },
      ],
    },
  }
  await pick(JSON.stringify({ tree: fork, fields: { amount: 'number' } }))
  await confirmImport()
  await expect(
    page.getByText(msg('validation.wf.fallback_count', 'zh-CN', { node: 'f1' })),
  ).toBeVisible()
  await expect(rows).toHaveCount(2)
  await page.keyboard.press('Escape')
  await expect(versions).toBeHidden()

  // the model's draft is the imported tree
  const model = (await (await request.get(`/api/wf/models/${id}`, { headers })).json()) as {
    data: { draftJson: { next: { name: string } } }
  }
  expect(model.data.draftJson.next.name).toBe('Boss imported')
})
