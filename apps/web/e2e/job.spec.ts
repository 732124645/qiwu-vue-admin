import { currentPage, bearer, expect, msg, signIn, test, type Page } from './fixtures.ts'

// Scheduler pages: a task built with the visual cron picker, run once, its run in the run
// log, and the task's detail drawer with the next 5 fire times (`-g task`); the run log's detail, delete
// and clean (`-g log`). Both on the demo.echo handler (harmless, finishes at once).

const field = (domain: 'task' | 'run', prop: string) => msg(`field.scheduler.${domain}.${prop}`)
const button = (page: Page, key: string, params: Record<string, string> = {}) =>
  page.getByRole('button', { name: msg(key, 'zh-CN', params), exact: true })
const row = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text })
const confirmBox = (page: Page) => page.getByRole('dialog', { name: msg('crud.confirm.title') })
const ECHO = msg('scheduler.handler.demo.echo')
const OK = '成功' // scheduler.run_outcome `ok` (a dict label, from the DB)

/** Reloads the list until `locator` shows: runs are written in the background. */
async function refreshUntil(page: Page, locator: ReturnType<Page['locator']>) {
  await expect(async () => {
    await button(page, 'crud.action.refresh').click()
    await expect(locator).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 15_000 })
}

test('task: a visual cron makes a task, run once, its run is listed, the drawer has the next 5 fire times', async ({
  page,
}) => {
  const name = 'e2e-job-task'
  await signIn(page, 'admin', '/scheduler/tasks')
  await expect(currentPage(page, 'menu.scheduler.task')).toBeVisible()

  await button(page, 'crud.action.create').click()
  const create = page.getByRole('dialog', {
    name: msg('crud.title.create', 'zh-CN', { name: msg('scheduler.task.entity') }),
  })
  await create.getByRole('textbox', { name: field('task', 'name') }).fill(name)
  // the handler comes from the registry and brings its default params
  await create.getByRole('combobox', { name: field('task', 'handler') }).click({ force: true })
  await page.getByRole('option', { name: new RegExp(`^${ECHO}`) }).click()
  const params = create.getByRole('textbox', { name: field('task', 'params') })
  await expect(params).toHaveValue(/"message": "hello"/)
  await params.fill('{"message": "e2e hello"}')

  // the picker: every hour (at minute 0, second 0) instead of the blank field's daily midnight
  const cron = create.getByRole('textbox', { name: msg('cron.expression') })
  await expect(cron).toHaveValue('0 0 0 * * *')
  await create.locator('.cron-editor__picker button').first().click()
  await page.getByRole('menuitem', { name: '小时', exact: true }).click()
  await expect(cron).toHaveValue('0 0 * * * *')
  await expect(create.locator('.cron-editor__times li')).toHaveCount(5)
  await create.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(page.getByText(msg('crud.msg.created'))).toBeVisible()
  await expect(create).toBeHidden()
  await expect(row(page, name)).toContainText(ECHO)
  await expect(row(page, name)).toContainText('0 0 * * * *')

  // run once
  await row(page, name)
    .getByRole('button', { name: msg('menu.action.run') })
    .click()
  await expect(confirmBox(page)).toContainText(name)
  await confirmBox(page)
    .getByRole('button', { name: msg('menu.action.run'), exact: true })
    .click()
  await expect(page.getByText(msg('scheduler.job.runStarted'))).toBeVisible()

  // the run log has it, with its output in the detail
  await page.goto('/scheduler/runs')
  await expect(currentPage(page, 'menu.scheduler.run')).toBeVisible()
  await refreshUntil(page, row(page, name))
  await expect(row(page, name)).toContainText(OK)
  await row(page, name).getByRole('button', { name }).click()
  const runDrawer = page.getByRole('dialog', {
    name: msg('crud.title.detail', 'zh-CN', { name: msg('scheduler.run.entity') }),
  })
  await expect(runDrawer).toContainText('e2e hello')
  await runDrawer.getByRole('button', { name: /close|关闭/i }).click()

  // the task's drawer: settings, the next 5 fire times, the latest run
  await page.goto('/scheduler/tasks')
  await row(page, name).getByRole('button', { name }).click()
  const drawer = page.getByRole('dialog', {
    name: msg('crud.title.detail', 'zh-CN', { name: msg('scheduler.task.entity') }),
  })
  await expect(drawer).toContainText(ECHO)
  await expect(drawer).toContainText(msg('cron.next', 'zh-CN', { count: 5 }))
  const times = drawer.locator('.job-detail__times li')
  await expect(times).toHaveCount(5)
  // hourly: every time at minute 0, second 0, an hour apart
  for (const text of await times.allTextContents()) expect(text).toMatch(/:00:00$/)
  await expect(drawer.getByRole('row').filter({ hasText: OK })).toHaveCount(1)
})

test('log: detail, delete one, export, clean', async ({ page, request }) => {
  // two runs of their own: two tasks run once through the API (run once is idempotent per task for 3 s)
  const auth = { Authorization: await bearer(request) }
  for (const name of ['e2e-job-log-a', 'e2e-job-log-b']) {
    const res = await request.post('/api/scheduler/tasks', {
      headers: auth,
      data: { name, handler: 'demo.echo', cron: '0 0 0 * * *', enabled: false, params: null },
    })
    expect(res.ok(), await res.text()).toBe(true)
    const { id } = ((await res.json()) as { data: { id: number } }).data
    const run = await request.post(`/api/scheduler/tasks/${id}/run`, { headers: auth })
    expect(run.ok(), await run.text()).toBe(true)
  }

  await signIn(page, 'admin', '/scheduler/runs')
  const search = page.locator('.qw-search-panel')
  await search.getByRole('textbox', { name: field('run', 'taskName') }).fill('e2e-job-log')
  await button(page, 'crud.action.search').click()
  await refreshUntil(page, row(page, 'e2e-job-log-b'))
  await expect(row(page, 'e2e-job-log-a')).toContainText(OK)

  // detail
  await row(page, 'e2e-job-log-a').getByRole('button', { name: 'e2e-job-log-a' }).click()
  const drawer = page.getByRole('dialog', {
    name: msg('crud.title.detail', 'zh-CN', { name: msg('scheduler.run.entity') }),
  })
  await expect(drawer).toContainText('demo.echo')
  await expect(drawer).toContainText('hello')
  await drawer.getByRole('button', { name: /close|关闭/i }).click()
  await expect(drawer).toBeHidden()

  // delete one
  await row(page, 'e2e-job-log-a')
    .getByRole('button', { name: msg('crud.action.delete') })
    .click()
  await confirmBox(page)
    .getByRole('button', { name: msg('crud.action.delete'), exact: true })
    .click()
  await expect(page.getByText(msg('crud.msg.deleted'))).toBeVisible()
  await expect(row(page, 'e2e-job-log-a')).toHaveCount(0)
  await expect(row(page, 'e2e-job-log-b')).toHaveCount(1)

  // export: the filtered rows
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    button(page, 'crud.action.export').click(),
  ])
  expect(file.suggestedFilename()).toBe(`${msg('menu.scheduler.run')}.xlsx`)

  // clean: every run goes
  await button(page, 'scheduler.run.clean').click()
  await confirmBox(page)
    .getByRole('button', { name: msg('scheduler.run.clean'), exact: true })
    .click()
  await expect(page.getByText(msg('scheduler.run.cleaned'))).toBeVisible()
  await button(page, 'crud.action.reset').click()
  await expect(page.getByText(msg('common.empty.title'), { exact: true })).toBeVisible()
})
