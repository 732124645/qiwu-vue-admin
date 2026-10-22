// Automations end to end (see docs/agent.md): a fake model (agent-fake.ts) answers every turn with a fixed
// summary. On the 自动化 page root adds a scheduled automation with the shortest preset (the schedule itself
// is saved and has a next run; waiting for it is not part of the test), then runs it now: the run finishes
// in a hidden thread, its history shows the summary, the result notice is in the inbox, and the hidden
// thread opens from the history with the answer in it.
import type { APIRequestContext } from '@playwright/test'
import { fakeModel } from './agent-fake.ts'
import { serverEnv } from './env.ts'
import { bearer, expect, msg, signIn, test } from './fixtures.ts'

const MODEL = 'e2e-automation-model'
const SUMMARY = 'E2E：今天没有需要跟进的客户。'
const PROMPT = '列出今天需要跟进的客户'

let fake: Awaited<ReturnType<typeof fakeModel>>
let api: APIRequestContext
let headers: Record<string, string>
let providerId: number | undefined
const created: number[] = []

test.beforeAll(async ({ playwright }) => {
  fake = await fakeModel(() => ({ text: SUMMARY }))
  api = await playwright.request.newContext({ baseURL: `http://127.0.0.1:${serverEnv.PORT}` })
  headers = { Authorization: await bearer(api) }
  const res = await api.post('/api/agent/providers', {
    headers,
    data: {
      name: 'E2E automation model',
      baseUrl: fake.url,
      apiKey: 'e2e-dummy-key-not-a-secret',
      models: [{ id: MODEL }],
      isDefault: true,
    },
  })
  expect(res.status(), await res.text()).toBe(201)
  providerId = ((await res.json()) as { data: { id: number } }).data.id
})

test.afterAll(async () => {
  for (const id of created) await api.delete(`/api/agent/automations/${id}`, { headers })
  if (providerId !== undefined) await api.delete(`/api/agent/providers/${providerId}`, { headers })
  await api?.dispose()
  await fake?.close()
})

interface Automation {
  id: number
  name: string
  nextRunAt: string | null
}
interface Run {
  status: string
  trigger: string
  summary: string | null
}

/** Root's automation by its name, as the API lists it. */
async function automation(name: string) {
  const res = await api.get('/api/agent/automations', { headers })
  expect(res.ok(), await res.text()).toBe(true)
  return ((await res.json()) as { data: Automation[] }).data.find((a) => a.name === name)
}

/** The status of the automation's latest manual run (a schedule that fires meanwhile adds its own). */
async function manualRun(id: number) {
  const res = await api.get(`/api/agent/automations/${id}/runs`, {
    headers,
    params: { page: 1, pageSize: 10 },
  })
  expect(res.ok(), await res.text()).toBe(true)
  const runs = ((await res.json()) as { data: { items: Run[] } }).data.items
  return runs.find((r) => r.trigger === 'manual')?.status
}

/** Whether root's inbox holds a message whose title names the automation. */
async function noticed(name: string) {
  const res = await api.get('/api/messaging/inboxes/mine', {
    headers,
    params: { page: 1, pageSize: 20 },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return ((await res.json()) as { data: { items: { title: string }[] } }).data.items.some((m) =>
    m.title.includes(name),
  )
}

test('a scheduled automation run now: history summary, inbox notice, hidden thread', async ({
  page,
}) => {
  const name = `E2E 自动化 ${Date.now()}`
  await signIn(page, 'admin', '/agent/automations')
  await page.getByRole('button', { name: msg('crud.action.create'), exact: true }).click()
  const form = page.getByRole('dialog', {
    name: msg('crud.title.create', 'zh-CN', { name: msg('agent.automation.entity') }),
  })
  await form.getByRole('textbox', { name: msg('field.agent.automation.name') }).fill(name)
  // 定时 is the default trigger: the shortest preset fills the cron
  await form
    .getByRole('combobox', { name: msg('agent.automation.preset.label') })
    .click({ force: true })
  await page
    .getByRole('option', { name: msg('agent.automation.preset.every30m'), exact: true })
    .click()
  await expect(form.getByRole('textbox', { name: msg('field.agent.automation.cron') })).toHaveValue(
    '*/30 * * * *',
  )
  await form.getByRole('textbox', { name: msg('field.agent.automation.prompt') }).fill(PROMPT)
  await form.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(form).toBeHidden()

  const row = page.getByRole('row').filter({ hasText: name })
  await expect(row).toContainText(msg('agent.automation.preset.every30m'))
  const saved = await automation(name)
  expect(saved, name).toBeDefined()
  created.push(saved!.id)
  // the schedule is registered: it has a next run
  expect(saved!.nextRunAt).not.toBeNull()

  await row.getByRole('button', { name: msg('agent.automation.runNow'), exact: true }).click()
  await expect(page.getByText(msg('agent.automation.started'))).toBeVisible()
  await expect.poll(() => manualRun(saved!.id), { timeout: 30_000 }).toBe('completed')

  // the run history shows the answer summary
  await row.getByRole('button', { name: msg('agent.automation.runs'), exact: true }).click()
  const history = page.getByRole('dialog', {
    name: msg('agent.automation.runsTitle', 'zh-CN', { name }),
  })
  const run = history
    .getByRole('row')
    .filter({ hasText: msg('agent.automation.trigger.manual') })
    .first()
  await expect(run).toContainText(msg('agent.automation.status.completed'))
  await expect(run).toContainText(SUMMARY)
  await page.keyboard.press('Escape')
  await expect(history).toBeHidden()

  // the result notice is in the inbox
  await expect.poll(() => noticed(name), { timeout: 10_000 }).toBe(true)
  const unread = msg('notify.bell.labelUnread', 'zh-CN', { count: '\\d+' })
  await page
    .getByRole('button', { name: new RegExp(`^(${msg('notify.bell.label')}|${unread})$`) })
    .click()
  await page.getByRole('tab', { name: msg('notify.tabs.inbox') }).click()
  const item = page.getByRole('button', { name: new RegExp(name) }).first()
  await expect(item).toBeVisible()
  await item.click()
  const notice = page.getByRole('dialog', { name: new RegExp(name) })
  await expect(notice).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(notice).toBeHidden()

  // the hidden thread opens from the history and holds the prompt and the answer
  await row.getByRole('button', { name: msg('agent.automation.runs'), exact: true }).click()
  await history
    .getByRole('row')
    .filter({ hasText: msg('agent.automation.trigger.manual') })
    .first()
    .getByRole('button', { name: msg('agent.automation.openThread'), exact: true })
    .click()
  await expect(page).toHaveURL(/\/agent\/chat\?thread=\d+/)
  const log = page.getByRole('log', { name: msg('agent.chat.messages') })
  await expect(log.getByText(PROMPT)).toBeVisible()
  await expect(log.getByText(SUMMARY)).toBeVisible()
})
