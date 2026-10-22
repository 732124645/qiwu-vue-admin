// Automatic review end to end (see docs/agent.md): a fake model (agent-fake.ts) serves both the chat model
// and the review model. Root sets the review model (`agent.review.model`) and the policy of the sample
// customer update tool to 自动审查 through the API; in 智能助手 the 自动审查 mode is picked before the first
// message and the chat model fills one empty field of a seeded customer. When the review model approves, the
// card shows the review's pass and its words and the write runs without a click; when it hands over, the
// card waits with its buttons and the write runs once the user approves.
import type { APIRequestContext, Locator } from '@playwright/test'
import { afterTool, fakeModel } from './agent-fake.ts'
import { serverEnv } from './env.ts'
import { bearer, expect, msg, signIn, test, type Page } from './fixtures.ts'

const MODEL = 'e2e-review-chat-model'
const REVIEW_MODEL = 'e2e-review-model'
const DONE = 'E2E：已补齐。'
const UPDATE = /customer.update$/

/** What the chat model proposes and what the review model answers, per test. */
let script: { id: number; field: string; value: string } | null = null
let verdict: { verdict: 'approve' | 'escalate'; reason: string } = {
  verdict: 'escalate',
  reason: '-',
}

let fake: Awaited<ReturnType<typeof fakeModel>>
let api: APIRequestContext
let headers: Record<string, string>
const providers: number[] = []
let tool: string | undefined
let reviewParam: { id: number; paramValue: string } | undefined

/** Adds a provider of the fake model as root; its id is removed again after the file. */
async function provider(name: string, model: string, isDefault: boolean) {
  const res = await api.post('/api/agent/providers', {
    headers,
    data: {
      name,
      baseUrl: fake.url,
      apiKey: 'e2e-dummy-key-not-a-secret',
      models: [{ id: model }],
      isDefault,
    },
  })
  expect(res.status(), await res.text()).toBe(201)
  const id = ((await res.json()) as { data: { id: number } }).data.id
  providers.push(id)
  return id
}

/** Sets the platform param `agent.review.model` through the settings API. */
async function setReviewModel(value: string) {
  const res = await api.put(`/api/settings/params/${reviewParam!.id}`, {
    headers,
    data: { paramValue: value },
  })
  expect(res.ok(), await res.text()).toBe(true)
}

/** Sets the policy of the update tool (`null`: back to its default). */
async function setPolicy(policy: string | null) {
  const res = await api.put(`/api/agent/tools/${tool}/policy`, { headers, data: { policy } })
  expect(res.ok(), await res.text()).toBe(true)
}

test.beforeAll(async ({ playwright }) => {
  fake = await fakeModel((body) => {
    if (body.model === REVIEW_MODEL) return { text: JSON.stringify(verdict) }
    // a turn's title and other plain completions
    if (!body.stream) return { text: 'E2E' }
    if (afterTool(body) || !script) return { text: DONE }
    return { tool: UPDATE, args: { id: script.id, [script.field]: script.value } }
  })
  api = await playwright.request.newContext({ baseURL: `http://127.0.0.1:${serverEnv.PORT}` })
  headers = { Authorization: await bearer(api) }
  await provider('E2E review chat model', MODEL, true)
  const reviewId = await provider('E2E review model', REVIEW_MODEL, false)

  const params = await api.get('/api/settings/params', {
    headers,
    params: { paramKey: 'agent.review.model', pageSize: 10 },
  })
  expect(params.ok(), await params.text()).toBe(true)
  reviewParam = (
    (await params.json()) as {
      data: { items: { id: number; paramKey: string; paramValue: string }[] }
    }
  ).data.items.find((p) => p.paramKey === 'agent.review.model')
  expect(reviewParam, 'agent.review.model').toBeDefined()
  await setReviewModel(`${reviewId}:${REVIEW_MODEL}`)

  const tools = await api.get('/api/agent/tools', { headers })
  expect(tools.ok(), await tools.text()).toBe(true)
  tool = ((await tools.json()) as { data: { name: string }[] }).data.find((t) =>
    UPDATE.test(t.name),
  )?.name
  expect(tool, 'customer update tool').toBeDefined()
  await setPolicy('review')
})

test.afterAll(async () => {
  if (tool) await setPolicy(null)
  if (reviewParam) await setReviewModel(reviewParam.paramValue)
  for (const id of providers) await api.delete(`/api/agent/providers/${id}`, { headers })
  await api?.dispose()
  await fake?.close()
})

interface Customer {
  id: number
  name: string
  industry: string | null
}

/** A seeded sample customer by its full name, its industry emptied first (a retry starts the same way). */
async function emptyCustomer(name: string): Promise<Customer> {
  const list = await api.get('/api/demo/customers', { headers, params: { name } })
  expect(list.ok(), await list.text()).toBe(true)
  const found = ((await list.json()) as { data: { items: Customer[] } }).data.items.find(
    (c) => c.name === name,
  )
  expect(found, name).toBeDefined()
  const put = await api.put(`/api/demo/customers/${found!.id}`, {
    headers,
    data: { industry: null },
  })
  expect(put.ok(), await put.text()).toBe(true)
  return found!
}

/** The customer's industry as the API reads it now. */
async function industryOf(id: number) {
  const res = await api.get(`/api/demo/customers/${id}`, { headers })
  expect(res.ok(), await res.text()).toBe(true)
  return ((await res.json()) as { data: Customer }).data.industry
}

/** Opens 智能助手 as root, picks 自动审查, sends `text` and returns the approval card of the update. */
async function askInReviewMode(page: Page, text: string) {
  await signIn(page, 'admin', '/agent/chat')
  const composer = page.getByRole('textbox', { name: msg('agent.chat.composer.label') })
  await expect(composer).toBeEnabled()
  await page
    .getByRole('combobox', { name: msg('agent.chat.composer.approvalMode') })
    .click({ force: true })
  await page.getByRole('option', { name: msg('agent.chat.mode.auto_review'), exact: true }).click()
  await composer.fill(text)
  await page.getByRole('button', { name: msg('agent.chat.composer.send'), exact: true }).click()
  const card = page.getByRole('region', { name: msg('agent.chat.approval.title') })
  await expect(card).toBeVisible({ timeout: 20_000 })
  return card
}

const answer = (page: Page) =>
  page.getByRole('log', { name: msg('agent.chat.messages') }).getByText(DONE)
const approveButton = (card: Locator) =>
  card.getByRole('button', { name: msg('agent.chat.approval.action.approve'), exact: true })

test('the review model approves: the write runs without a click and the card says so', async ({
  page,
}) => {
  const c = await emptyCustomer('Siemens AG')
  script = { id: c.id, field: 'industry', value: '工业自动化' }
  verdict = { verdict: 'approve', reason: 'E2E：与用户的要求一致，只补一个空字段。' }
  const card = await askInReviewMode(page, `补齐 ${c.name} 的行业`)

  const review = card.getByRole('status')
  await expect(review).toContainText(msg('agent.review.card.approve'))
  await expect(review).toContainText(msg('agent.review.card.said'))
  await expect(review).toContainText(verdict.reason)
  await expect(approveButton(card)).toHaveCount(0)
  await expect(answer(page)).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => industryOf(c.id)).toBe('工业自动化')
})

test('the review model hands over: the card waits, the user approves and the write runs', async ({
  page,
}) => {
  const c = await emptyCustomer('Unilever PLC')
  script = { id: c.id, field: 'industry', value: '日用消费品' }
  verdict = { verdict: 'escalate', reason: 'E2E：请本人确认这次修改。' }
  const card = await askInReviewMode(page, `补齐 ${c.name} 的行业`)

  const review = card.getByRole('status')
  await expect(review).toContainText(msg('agent.review.card.escalate'))
  await expect(review).toContainText(verdict.reason)
  await expect(approveButton(card)).toBeVisible()
  await expect(
    card.getByRole('button', { name: msg('agent.chat.approval.action.reject'), exact: true }),
  ).toBeVisible()
  // nothing is written while the card waits
  expect(await industryOf(c.id)).toBeNull()

  await approveButton(card).click()
  await expect(answer(page)).toBeVisible({ timeout: 20_000 })
  await expect(
    card.getByText(msg('agent.chat.approval.decision.approve'), { exact: true }),
  ).toBeVisible()
  await expect.poll(() => industryOf(c.id)).toBe('日用消费品')
})
