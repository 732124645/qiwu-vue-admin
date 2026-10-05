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
import { USERS } from './env.ts'

// The start page 发起申请. A card per model the caller may start (GET
// /api/wf/startable-models, sign-in only), grouped by category in the dict's order, names through tx() in
// both languages; a custom-form model opens its create_route (global setup publishes one by hand: no
// business handler here); a dynamic one starts in a dialog that asks the users of its initiatorPicks steps
// (UserPicker, each step at least one) or, without such steps, only confirms. A model scoped to root is
// offered to root, not to the staff user.

const EN = 'en-US'
const PICKS = { modelKey: 'e2e-start-picks', name: 'E2E expense claim' }
const ROOT_ONLY = { modelKey: 'e2e-start-root', name: 'E2E root only' }
/** the custom model global-setup.ts publishes: its name is a menu key, its create_route /profile */
const CUSTOM = 'menu.biz.leave'
const LEAD = 'seed.position.engLead'
const COPY = 'E2E copy'

type Api = Parameters<typeof bearer>[0]
const review = (id: string, name: string) => ({
  id,
  type: 'review',
  name,
  assignee: { kind: 'initiatorPicks' },
  sign: 'any',
  whenNobody: 'autoPass',
  whenInitiatorIsReviewer: 'self',
  onReject: 'finish',
})
const begin = (next?: object) => ({ id: 'begin', type: 'begin', name: 'Begin', next })

/** The two dynamic models, once per run (either test may run alone). */
let models: Promise<void> | undefined
const setUp = (request: Api) =>
  (models ??= (async () => {
    const headers = { Authorization: await bearer(request) }
    const pick = review('lead', LEAD)
    const copy = { id: 'copy', type: 'notify', name: COPY, assignee: { kind: 'initiatorPicks' } }
    await publishModel(request, headers, PICKS, begin({ ...pick, next: copy }))
    const admin = await userId(request, headers, USERS.admin.username)
    await publishModel(
      request,
      headers,
      { ...ROOT_ONLY, initiatorScope: { userIds: [admin] } },
      begin(),
    )
  })())

const card = (page: Page, name: string) => page.getByRole('button', { name, exact: true })
/** the category groups named by `names`, in page order */
const groups = (page: Page, names: RegExp) =>
  page.getByRole('heading', { level: 2 }).filter({ hasText: names })
const startDialog = (page: Page, name: string, lang = 'zh-CN') =>
  page.getByRole('dialog', { name: msg('wf.center.start.title', lang, { name }) })

test('root: a model scoped to root; without steps to pick for, the dialog only confirms', async ({
  page,
  request,
}) => {
  await setUp(request)
  await signIn(page, 'admin', '/workflow/start')
  await expect(currentPage(page, 'menu.workflow.start')).toBeVisible()
  await card(page, ROOT_ONLY.name).click()
  const dialog = startDialog(page, ROOT_ONLY.name)
  await expect(dialog.getByText(msg('wf.center.start.confirm'))).toBeVisible()
  const answered = page.waitForResponse((r) => r.url().endsWith('/api/wf/instances'))
  await dialog.getByRole('button', { name: msg('wf.center.start.submit') }).click()
  expect((await answered).status()).toBe(201)
  await expect(dialog).toBeHidden()
  await expect(page.getByText(msg('wf.center.start.started'))).toBeVisible()
})

test('staff: cards by category, a custom model opens its page, picked steps take users, en-US names', async ({
  page,
  request,
}) => {
  await setUp(request)
  const headers = { Authorization: await bearer(request) }
  const limited = await userId(request, headers, USERS.limited.username)
  await signIn(page, 'staff', '/home')
  const menu = page.getByRole('navigation', { name: msg('common.layout.sideMenu') })
  await menu.getByText(msg('menu.workflow.title')).click()
  await menu.getByRole('menuitem', { name: msg('menu.workflow.start') }).click()
  await expect(page).toHaveURL(/\/workflow\/start$/)

  // dict wf.category order (hr before finance; other specs' models may add groups of their own); the
  // seeded-key name through tx(); root's model not offered
  await expect(groups(page, /^(人事|财务)$/)).toHaveText(['人事', '财务'])
  await expect(card(page, msg(CUSTOM))).toBeVisible()
  await expect(card(page, PICKS.name)).toBeVisible()
  await expect(card(page, ROOT_ONLY.name)).toHaveCount(0)

  // a custom-form model: its business page
  await card(page, msg(CUSTOM)).click()
  await expect(page).toHaveURL(/\/profile$/)
  await expect(currentPage(page, 'profile.title')).toBeVisible()
  await page.goBack()

  // a dynamic model: each initiatorPicks step (name through tx(), its kind) needs someone
  await card(page, PICKS.name).click()
  const dialog = startDialog(page, PICKS.name)
  const step = (name: string) => dialog.locator('.el-form-item').filter({ hasText: name })
  await expect(step(msg(LEAD))).toContainText(msg('wf.designer.type.review'))
  await expect(step(COPY)).toContainText(msg('wf.designer.type.notify'))
  let starts = 0
  page.on('request', (r) => {
    if (r.url().endsWith('/api/wf/instances')) starts++
  })
  const submit = dialog.getByRole('button', { name: msg('wf.center.start.submit') })
  await submit.click()
  for (const node of [msg(LEAD), COPY])
    await expect(
      dialog.getByText(msg('validation.wf.picks_missing', 'zh-CN', { node })),
    ).toBeVisible()
  expect(starts).toBe(0)

  // UserPicker for both steps: every enabled user (the staff user's own_rows scope holds only themselves)
  const picker = page.getByRole('dialog', { name: msg('picker.user.title') })
  for (const name of [msg(LEAD), COPY]) {
    await step(name)
      .getByRole('button', { name: msg('wf.designer.assignee.pickUsers') })
      .click()
    await picker
      .getByRole('textbox', { name: msg('field.iam.user.keyword') })
      .fill(USERS.limited.username)
    await picker.getByRole('row').filter({ hasText: USERS.limited.username }).click()
    await picker.getByRole('button', { name: msg('picker.user.confirm') }).click()
    await expect(picker).toBeHidden()
    await expect(step(name).locator('.el-tag')).toHaveText([USERS.limited.username])
  }
  await expect(
    dialog.getByText(msg('validation.wf.picks_missing', 'zh-CN', { node: COPY })),
  ).toBeHidden()
  const posted = page.waitForRequest((r) => r.url().endsWith('/api/wf/instances'))
  const answered = page.waitForResponse((r) => r.url().endsWith('/api/wf/instances'))
  await submit.click()
  expect((await posted).postDataJSON()).toEqual({
    modelKey: PICKS.modelKey,
    // a model without a form (a bound form's values go here)
    formValues: {},
    initiatorPicks: { lead: [limited], copy: [limited] },
  })
  expect((await answered).status()).toBe(201)
  await expect(dialog).toBeHidden()
  await expect(page.getByText(msg('wf.center.start.started'))).toBeVisible()

  // en-US: categories, the seeded-key card name and step name in English
  await page.getByRole('button', { name: msg('common.layout.language') }).click()
  await page.getByRole('menuitem', { name: msg('common.language.enUS') }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', EN)
  await expect(groups(page, /^(HR|Finance)$/)).toHaveText(['HR', 'Finance'])
  await expect(card(page, msg(CUSTOM, EN))).toBeVisible()
  await card(page, PICKS.name).click()
  const en = startDialog(page, PICKS.name, EN)
  await expect(en.locator('.el-form-item').filter({ hasText: msg(LEAD, EN) })).toContainText(
    msg('wf.designer.type.review', EN),
  )
  await en.getByRole('button', { name: msg('common.action.cancel', EN) }).click()
  await expect(en).toBeHidden()
})
