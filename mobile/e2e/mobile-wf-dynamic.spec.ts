// Dynamic form renderer on the H5 build, over the workflow APIs: a dynamic model with a form starts on its form
// page (the designer's texts by language, the client's pre-check = the server's rules, the calc results shown
// and recomputed by the server); on the detail the reviewer's step access hides, shows and opens fields (only
// `edit` ones are sent with the approval), and showing the page again (a file / photo picker returning on a
// phone) keeps what was typed; en-US.
import { expect, test, type Page } from '@playwright/test'
import { bearer, clientIp, data, serverScript, signIn, type User } from './env'
import { EMPLOYEE, SUPERVISOR, detailUrl, open, openAs, seedWf, sheet, state, submit } from './wf'

const MODEL = { key: 'm_wf_dyn', name: 'M-wf dynamic' }
const TEXTS = {
  'zh-cn': {
    kind: '请假类型',
    start: '开始日期',
    end: '结束日期',
    days: '天数',
    reason: '事由',
    budget: 'Budget',
    level: '级别',
    low: '一般',
    high: '紧急',
    urgent: '加急',
    items: '明细',
    note: '说明',
    amount: '金额',
    secret: '备注',
  },
  en: {
    kind: 'Leave type',
    start: 'Start date',
    end: 'End date',
    days: 'Days',
    reason: 'Reason',
    budget: 'Budget',
    level: 'Level',
    low: 'Low',
    high: 'High',
    urgent: 'Urgent',
    items: 'Items',
    note: 'Note',
    amount: 'Amount',
    secret: 'Secret note',
  },
}
const title = (id: keyof (typeof TEXTS)['en']) => `{{$t.${id}}}`
const SCHEMA = {
  rule: [
    {
      type: 'qw-dict-select',
      field: 'leaveKind',
      title: title('kind'),
      $required: true,
      props: { code: 'biz.leave_kind' },
    },
    { type: 'datePicker', field: 'startDate', title: title('start'), $required: true, props: { type: 'date' } },
    { type: 'datePicker', field: 'endDate', title: title('end'), $required: true, props: { type: 'date' } },
    {
      type: 'qw-date-range-days',
      field: 'days',
      title: title('days'),
      props: { startField: 'startDate', endField: 'endDate' },
    },
    { type: 'input', field: 'reason', title: title('reason'), $required: true, props: { type: 'textarea' } },
    { type: 'inputNumber', field: 'budget', title: title('budget') },
    {
      type: 'radio',
      field: 'level',
      title: title('level'),
      options: [
        { label: title('low'), value: 'low' },
        { label: title('high'), value: 'high' },
      ],
    },
    { type: 'switch', field: 'urgent', title: title('urgent') },
    {
      type: 'qw-detail-table',
      field: 'items',
      title: title('items'),
      props: {
        columns: [
          { prop: 'note', label: title('note') },
          { prop: 'amount', label: title('amount'), sum: 'total' },
        ],
      },
    },
    { type: 'input', field: 'secret', title: title('secret') },
  ],
  option: { language: TEXTS },
}

// Straight into the throwaway database: the model (hr), published with its form; the supervisor reviews,
// may edit the reason and never sees the secret.
const SEED = `
import { compile, fieldsFromFormSchema, sanitizeFormSchema } from '@qiwu/shared'
import { DataSource } from 'typeorm'
import { dataSourceOptions } from './dist/db/data-source.js'
import { insertRow } from './dist/db/seeds/upsert.js'
const { MODEL, NAME, SCHEMA } = process.env
const ds = await new DataSource(dataSourceOptions()).initialize()
try {
  await ds.transaction(async (q) => {
    if ((await q.query('SELECT id FROM wf_model WHERE model_key = ?', [MODEL])).length) return
    const s = sanitizeFormSchema(JSON.parse(SCHEMA))
    if (!s.ok) throw new Error(JSON.stringify(s.errors))
    const f = fieldsFromFormSchema(s.schema)
    if (!f.ok) throw new Error(JSON.stringify(f.errors))
    const [sup] = await q.query("SELECT id FROM iam_user WHERE username = 'oa.supervisor'")
    const r = compile({ id: 'begin', type: 'begin', name: 'Begin', next: {
      id: 'check', type: 'review', name: 'M-wf dyn check', assignee: { kind: 'users', ids: [sup.id] },
      sign: 'any', whenNobody: 'autoPass', whenInitiatorIsReviewer: 'self', onReject: 'finish',
      access: { secret: 'hide', reason: 'edit', budget: 'edit' },
    } }, f.fields)
    if (!r.ok) throw new Error(JSON.stringify(r))
    const model = await insertRow(q, 'wf_model', {
      model_key: MODEL, name: NAME, category: 'hr', form_kind: 'dynamic', draft_json: r.flow.root,
    })
    const version = await insertRow(q, 'wf_version', {
      model_id: model, model_key: MODEL, version: 1, tree_json: r.flow.root,
      form_snapshot: { fields: f.fields, schema: s.schema },
    })
    await q.query('UPDATE wf_model SET current_version_id = ? WHERE id = ?', [version, model])
  })
} finally {
  await ds.destroy()
}
`

test.beforeAll(() => {
  seedWf()
  serverScript(SEED, { MODEL: MODEL.key, NAME: MODEL.name, SCHEMA: JSON.stringify(SCHEMA) })
})

const field = (page: Page, name: string) => page.locator(`.qw-pf__field--${name}`)
const row = (page: Page, name: string) => page.locator(`.qw-pf__kv--${name}`)
const formSubmit = (page: Page) => page.locator('.qw-start-form__submit')
const isStart = (r: { url(): string; method(): string }) =>
  r.method() === 'POST' && r.url().endsWith('/api/wf/instances')

/** `user` signs in on a fresh app (English: switched first) and opens the model's form page. */
async function formPage(page: Page, user: User, english = false) {
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
  await page.locator('.qw-start__model', { hasText: MODEL.name }).click()
  await expect(page).toHaveURL(/#\/pages-wf\/start\/form\?key=m_wf_dyn&/)
  await expect(formSubmit(page)).toBeVisible()
}

/** The employee starts the model through the API with these values; its instance. */
async function startWith(request: Parameters<typeof bearer>[0], formValues: object) {
  const res = request.post('/api/wf/instances', {
    headers: await bearer(request, EMPLOYEE),
    data: { modelKey: MODEL.key, formValues },
  })
  return (await data<{ id: number }>(res)).id
}
const FORGED = {
  leaveKind: 'personal',
  startDate: '2026-12-07',
  endDate: '2026-12-09',
  days: 99,
  reason: 'first',
  budget: 500,
  items: JSON.stringify([
    { note: 'a', amount: 10 },
    { note: 'b', amount: 5.5 },
  ]),
  total: 1,
  secret: 'S3CRET-x',
}

test('start: the form, its pre-check, the days and totals shown, the values sent', async ({ page }) => {
  test.slow()
  await formPage(page, EMPLOYEE)
  await expect(page).toHaveTitle(MODEL.name)
  // the designer's texts in Chinese; the days a read-only row
  for (const [name, label] of [
    ['leaveKind', '请假类型'],
    ['startDate', '开始日期'],
    ['reason', '事由'],
    ['level', '级别'],
    ['urgent', '加急'],
    ['items', '明细'],
  ])
    await expect(field(page, name!)).toContainText(label!)
  await expect(row(page, 'days')).toContainText('天数')
  await expect(field(page, 'days')).toHaveCount(0)

  // nothing is posted until the server's rules pass
  let starts = 0
  page.on('request', (r) => void (isStart(r) && starts++))
  await formSubmit(page).click()
  for (const [name, message] of [
    ['leaveKind', '请假类型不能为空'],
    ['startDate', '开始日期不能为空'],
    ['endDate', '结束日期不能为空'],
    ['reason', '事由不能为空'],
  ])
    await expect(field(page, name!).locator('.qw-field__error')).toHaveText(message!)
  expect(starts).toBe(0)

  await field(page, 'leaveKind').locator('.wd-cell').click()
  await page.locator('.wd-select-picker__radio-item', { hasText: '事假' }).click()
  await expect(field(page, 'leaveKind')).toContainText('事假')
  // both dates as the picker offers them (today): 1 day
  for (const name of ['startDate', 'endDate']) {
    await field(page, name).locator('.wd-cell').click()
    await page.locator('.wd-datetime-picker__action').filter({ visible: true }).last().click()
    await expect(field(page, name).locator('.wd-cell__value')).toHaveText(/^\d{4}-\d\d-\d\d$/)
  }
  await expect(row(page, 'days')).toContainText('1 天')
  await field(page, 'reason').locator('textarea').fill('m-wfdyn family matters')
  await field(page, 'level').locator('.wd-cell').click()
  await page.locator('.wd-select-picker__radio-item', { hasText: '紧急' }).click()
  await expect(field(page, 'level')).toContainText('紧急')
  await field(page, 'urgent').locator('.wd-switch').click()
  // two rows; the total follows
  const items = field(page, 'items')
  await items.locator('.qw-rows__add').click()
  await items.locator('.qw-rows__add').click()
  for (const [i, [note, amount]] of [
    ['taxi', '120.5'],
    ['meal', '30'],
  ].entries()) {
    const r = items.locator('.qw-rows__row').nth(i)
    await r.locator('.qw-rows__cell--note input').fill(note!)
    await r.locator('.qw-rows__cell--amount input').fill(amount!)
  }
  await expect(items.locator('.qw-rows__total')).toContainText('150.5')
  await expect(page.locator('.qw-start-form .qw-field__error')).toHaveCount(0)

  const posted = page.waitForResponse((r) => isStart(r.request()))
  await formSubmit(page).click()
  const res = await posted
  expect(res.status(), await res.text()).toBe(201)
  const { formValues } = res.request().postDataJSON() as { formValues: Record<string, unknown> }
  expect(formValues).toMatchObject({
    leaveKind: 'personal',
    startDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    endDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    days: 1,
    reason: 'm-wfdyn family matters',
    level: 'high',
    urgent: true,
    total: 150.5,
  })
  expect(JSON.parse(formValues.items as string)).toEqual([
    { note: 'taxi', amount: 120.5 },
    { note: 'meal', amount: 30 },
  ])
  // its detail: the form read-only
  const { id } = ((await res.json()) as { data: { id: number } }).data
  await expect(page).toHaveURL(new RegExp(`#/pages-wf/detail/index\\?id=${id}$`))
  await expect(state(page)).toContainText('审批中')
  await expect(row(page, 'days')).toContainText('1 天')
  await expect(row(page, 'level')).toContainText('紧急')
  await expect(page.locator('.qw-wf__dynamic textarea')).toHaveCount(0)
})

test('the reviewer: hidden fields never arrive, server-computed calc, only the edit field is sent, typed values survive a picker', async ({
  page,
  request,
}) => {
  test.slow()
  const id = await startWith(request, FORGED)
  const detail = page.waitForResponse(
    (r) => r.request().method() === 'GET' && r.url().endsWith(`/api/wf/instances/${id}`),
  )
  await openAs(page, SUPERVISOR, id)
  const vo = ((await (await detail).json()) as { data: { formValues: object; schema: { rule: { field: string }[] } } })
    .data
  expect(vo.formValues).not.toHaveProperty('secret')
  expect(vo.schema.rule.map((r) => r.field)).not.toContain('secret')
  await expect(page.locator('.qw-wf__dynamic')).toBeVisible()
  await expect(page.locator('.qw-pf__field--secret, .qw-pf__kv--secret')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('S3CRET-x')
  // the server recomputed what the client forged
  await expect(row(page, 'days')).toContainText('3 天')
  await expect(field(page, 'items').locator('.qw-rows__total')).toContainText('15.5')
  await expect(field(page, 'items').locator('.qw-rows__add')).toHaveCount(0)
  await expect(row(page, 'leaveKind')).toContainText('事假')
  // the reason is the reviewer's to edit, checked before the sheet opens
  const reason = field(page, 'reason').locator('textarea')
  await expect(reason).toHaveValue('first')
  const budget = field(page, 'budget').locator('input')
  await expect(budget).toHaveValue('500')
  await budget.fill('')
  await reason.fill('')
  await page.locator('.qw-decide-bar__approve').click()
  await expect(field(page, 'reason').locator('.qw-field__error')).toHaveText('事由不能为空')
  await expect(sheet(page)).toBeHidden()
  await reason.fill('second')
  await expect(field(page, 'reason').locator('.qw-field__error')).toHaveCount(0)

  // Shown again (a picker returning: the app back in the foreground) keeps what was typed, no reload
  const reloaded = page
    .waitForResponse((r) => r.request().method() === 'GET' && r.url().endsWith(`/api/wf/instances/${id}`), {
      timeout: 1500,
    })
    .then(
      () => true,
      () => false,
    )
  // uni-h5 shows and hides the page on visibilitychange, as mp-weixin / App do on a picker (a string: the
  // e2e tsconfig has no DOM types)
  await page.evaluate(`for (const state of ['hidden', 'visible']) {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  }`)
  const again = await reloaded
  // a reload, had there been one, has rendered by now
  await page.waitForTimeout(300)
  expect(await reason.inputValue()).toBe('second')
  expect(again).toBe(false)

  await open(page, 'approve')
  expect(await submit(page)).toEqual({ formValues: { reason: 'second', budget: null } })
  await expect(state(page)).toContainText('已通过')

  await openAs(page, EMPLOYEE, id)
  await expect(row(page, 'reason')).toContainText('second')
  await expect(row(page, 'secret')).toContainText('S3CRET-x')
  await expect(state(page)).toContainText('已通过')

  const stored = await data<{ formValues: { budget: unknown } }>(request.get(`/api/wf/instances/${id}`, {
    headers: await bearer(request, EMPLOYEE),
  }))
  expect(stored.formValues.budget).toBeNull()
})

test('en-US: the form page and the detail in English', async ({ page, request }) => {
  const id = await startWith(request, FORGED)
  await formPage(page, EMPLOYEE, true)
  for (const [name, label] of [
    ['leaveKind', 'Leave type'],
    ['startDate', 'Start date'],
    ['reason', 'Reason'],
    ['items', 'Items'],
  ])
    await expect(field(page, name!)).toContainText(label!)
  await expect(row(page, 'days')).toContainText('Days')
  await expect(field(page, 'items').locator('.qw-rows__add')).toHaveText('Add item')
  await expect(formSubmit(page)).toHaveText('Start')

  await page.goto(detailUrl(id))
  await expect(row(page, 'days')).toContainText('3 days')
  await expect(row(page, 'level')).toHaveCount(1)
  await expect(row(page, 'leaveKind')).toContainText('Personal leave')
})
