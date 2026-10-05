import { createRequire } from 'node:module'
import type { APIRequestContext, APIResponse } from '@playwright/test'
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

// 审批数据 with the tail of the wizard acceptance: a leave process copied from the
// built-in leave template (its form, a supervisor step), started twice by the OA employee (4 and 2 days), the
// 4-day one approved by the supervisor; then the form gains a field and version 2 is published, its supervisor
// step hiding the new field. Root picks the process: the columns are the fixed ones plus version 2's form
// fields (titled as the form shows them; root sees the hidden one too, no withheld hint), both
// instances listed (all versions), user and dept by name; days > 3 finds the approved leave; the export has
// the page's columns and that row; version 1 drops the new column and the field filters. The staff user
// (no wfPerms) gets no page.

const KEY = 'e2e-data-leave'
const NAME = 'E2E data leave'
const DESTINATION = 'Destination'
const APPROVED_REASON = 'e2e data family visit'
const RUNNING_REASON = 'e2e data short trip'
/** dict labels (seeded in the database, not in the locale files) */
const APPROVED = '已通过'
const RUNNING = '审批中'

/** exceljs from the server's dependencies reads the export (no web dependency for a test) */
const ExcelJS = createRequire(new URL('../../server/package.json', import.meta.url))('exceljs') as {
  Workbook: new () => {
    xlsx: { load(b: Buffer): Promise<unknown> }
    worksheets: { eachRow(cb: (row: { values: unknown[] }) => void): void }[]
  }
}
async function rowsOf(file: { createReadStream(): Promise<NodeJS.ReadableStream> }) {
  const chunks: Buffer[] = []
  for await (const chunk of await file.createReadStream()) chunks.push(chunk as Buffer)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(Buffer.concat(chunks))
  const rows: unknown[][] = []
  wb.worksheets[0]!.eachRow((r) => rows.push(r.values.slice(1)))
  return rows
}

type Schema = { rule: object[]; option: { language: Record<string, Record<string, string>> } }
async function data<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), await res.text()).toBe(true)
  return ((await res.json()) as { data: T }).data
}

const begin = (next: object) => ({ id: 'begin', type: 'begin', name: 'Begin', next })
const review = (ids: number[]) => ({
  id: 'lead',
  type: 'review',
  name: 'seed.wf.node.supervisor',
  assignee: { kind: 'users', ids },
  sign: 'any',
  whenNobody: 'autoPass',
  whenInitiatorIsReviewer: 'self',
  onReject: 'finish',
})

/** The OA employee's leave from `start` to `end` (a session of its own: the duplicate-submit guard). */
async function startLeave(
  request: APIRequestContext,
  [start, end, days]: [string, string, number],
  reason: string,
) {
  const res = await request.post('/api/wf/instances', {
    headers: { Authorization: await bearer(request, USERS.oaEmployee) },
    data: {
      modelKey: KEY,
      formValues: { leaveKind: 'personal', startDate: start, endDate: end, days, reason },
    },
  })
  expect(res.status(), await res.text()).toBe(201)
  return ((await res.json()) as { data: { id: number } }).data.id
}

/** The process, its two instances (one approved) and version 2; the form's zh-cn texts by field. */
async function setUp(request: APIRequestContext) {
  const root = { Authorization: await bearer(request) }
  const models = (modelKey: string) =>
    request.get('/api/wf/models', { headers: root, params: { modelKey } })
  const [template] = (await data<{ items: { formId: number }[] }>(await models('tpl-leave'))).items
  const { schemaJson } = await data<{ schemaJson: Schema }>(
    await request.get(`/api/wf/forms/${template!.formId}`, { headers: root }),
  )
  const form = await data<{ id: number }>(
    await request.post('/api/wf/forms', { headers: root, data: { name: NAME, schemaJson } }),
  )
  const supervisor = await userId(request, root, USERS.oaSupervisor.username)
  const tree = begin(review([supervisor]))
  await publishModel(request, root, { modelKey: KEY, name: NAME, formId: form.id }, tree)

  const approved = await startLeave(request, ['2026-10-12', '2026-10-15', 4], APPROVED_REASON)
  await startLeave(request, ['2026-11-02', '2026-11-03', 2], RUNNING_REASON)
  const lead = { Authorization: await bearer(request, USERS.oaSupervisor) }
  const todo = await data<{ items: { id: number; instance: { id: number } }[] }>(
    await request.get('/api/wf/tasks/todo', { headers: lead, params: { pageSize: 100 } }),
  )
  const task = todo.items.find((t) => t.instance.id === approved)!
  await data(await request.post(`/api/wf/tasks/${task.id}/approve`, { headers: lead, data: {} }))

  // version 2: one more field
  const rule = [...schemaJson.rule, { type: 'input', field: 'destination', title: DESTINATION }]
  await data(
    await request.put(`/api/wf/forms/${form.id}`, {
      headers: root,
      data: { schemaJson: { ...schemaJson, rule } },
    }),
  )
  const [model] = (await data<{ items: { id: number }[] }>(await models(KEY))).items
  // a session of its own: the duplicate-submit guard keys on it (version 1 went out just now); the
  // supervisor step hides the new field (only root and the process admins see it here)
  const hiding = begin({ ...review([supervisor]), access: { destination: 'hide' } })
  await data(
    await request.post(`/api/wf/models/${model!.id}/versions`, {
      headers: { Authorization: await bearer(request) },
      data: { tree: hiding, fields: {} },
    }),
  )
  return schemaJson.option.language['zh-cn']!
}

const rows = (page: Page) => page.locator('.el-table__body tr')
const headers = (page: Page) => page.locator('.el-table__header-wrapper th .cell')
const combobox = (page: Page, key: string) => page.getByRole('combobox', { name: msg(key) })
async function choose(page: Page, key: string, option: string) {
  await combobox(page, key).click({ force: true })
  await page.getByRole('option', { name: option, exact: true }).click()
}
/** Resolves with the next data request's query once it answered. */
const listed = (page: Page) =>
  page
    .waitForResponse((r) => new URL(r.url()).pathname === `/api/wf/models/${KEY}/data`)
    .then((r) => new URL(r.url()).searchParams)

test('a leave process: its form fields as columns, days > 3 hits the approved leave, the export matches', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000)
  const texts = await setUp(request)
  const fixed = ['id', 'state', 'initiator', 'dept', 'startedAt', 'endedAt'].map((p) =>
    msg(`field.wf.data.${p}`),
  )
  const form = ['leaveKind', 'startDate', 'endDate', 'days', 'reason'].map((f) => texts[f]!)

  await signIn(page, 'admin', '/wf/data')
  await expect(currentPage(page, 'menu.wf.data')).toBeVisible()
  await expect(page.locator('.el-table').getByText(msg('wf.data.pickModel'))).toBeVisible()
  let query = listed(page)
  await choose(page, 'wf.data.model', NAME)
  expect((await query).get('version')).toBeNull()

  // the current version (2): its fields in form order after the fixed columns; both instances
  await expect(headers(page)).toHaveText([...fixed, ...form, DESTINATION])
  await expect(page.locator('.wf-data__withheld')).toHaveCount(0)
  await expect(
    page.locator('.el-select').filter({ has: combobox(page, 'field.wf.data.version') }),
  ).toContainText(msg('wf.data.currentVersion', 'zh-CN', { version: 2 }))
  await expect(rows(page)).toHaveCount(2)
  const approvedRow = rows(page).filter({ hasText: APPROVED_REASON })
  for (const text of [APPROVED, 'OA Employee', msg('seed.dept.platform'), '2026-10-12', '4'])
    await expect(approvedRow).toContainText(text)
  await expect(rows(page).filter({ hasText: RUNNING_REASON })).toContainText(RUNNING)

  // days > 3: the approved leave alone
  await page.getByRole('button', { name: msg('wf.data.addFilter') }).click()
  await choose(page, 'wf.designer.cond.field', texts.days!)
  await choose(page, 'wf.designer.cond.op', msg('wf.designer.op.gt'))
  await page.getByRole('spinbutton', { name: msg('wf.designer.cond.value') }).fill('3')
  query = listed(page)
  await page.getByRole('button', { name: msg('crud.action.search'), exact: true }).click()
  expect(JSON.parse((await query).get('filters')!)).toEqual([{ field: 'days', op: 'gt', value: 3 }])
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page)).toContainText(APPROVED_REASON)

  // the export: the page's columns, the filtered row (dept by name)
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: msg('crud.action.export'), exact: true }).click(),
  ])
  expect(file.suggestedFilename()).toBe(`${msg('menu.wf.data')}.xlsx`)
  const [header, ...cells] = await rowsOf(file)
  expect(header).toEqual(await headers(page).allInnerTexts())
  expect(cells).toHaveLength(1)
  expect(cells[0]).toEqual(
    expect.arrayContaining([APPROVED, 'OA Employee', msg('seed.dept.platform'), 4]),
  )
  expect(cells[0]).toContain(APPROVED_REASON)

  // version 1: no new column, the field filters start over
  query = listed(page)
  await choose(page, 'field.wf.data.version', msg('wf.data.versionOption', 'zh-CN', { version: 1 }))
  const sent = await query
  expect(sent.get('version')).toBe('1')
  expect(sent.get('filters')).toBeNull()
  await expect(headers(page)).toHaveText([...fixed, ...form])
  await expect(page.getByRole('spinbutton', { name: msg('wf.designer.cond.value') })).toHaveCount(0)
  await expect(rows(page)).toHaveCount(2)

  // column settings: the fixed columns only (stored props are `[\w.]`), a form field always shown after them
  await page.getByRole('button', { name: msg('crud.action.columns') }).click()
  const tree = page.getByRole('tree', { name: msg('crud.action.columns') })
  await expect(tree.getByRole('treeitem')).toHaveText(fixed)
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/prefs/table.wf.data') && r.request().method() === 'PUT',
  )
  await tree.getByRole('treeitem').filter({ hasText: fixed[5]! }).locator('.el-checkbox').click()
  expect((await saved).ok()).toBe(true)
  await expect(headers(page)).toHaveText([...fixed.slice(0, 5), ...form])
})

test('staff (no wfPerms): no 审批数据 page', async ({ page }) => {
  await signIn(page, 'staff', '/wf/data')
  await expect(page.getByText(msg('common.error.notFound'))).toBeVisible()
})
