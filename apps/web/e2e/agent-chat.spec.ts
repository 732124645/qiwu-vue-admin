// The in-app assistant end to end (see docs/agent.md): a tiny OpenAI-compatible Chat Completions server in
// this spec stands in for the model provider (streaming SSE, scripted by the conversation: no tool result yet
// → a `demo.customer.update` call filling one empty field of a seeded sample customer; a tool result → the
// final answer). Root registers it as the default provider through the API with a dummy key (provider base
// URLs are not address-checked, so the e2e server reaches it on 127.0.0.1). In the browser: 智能助手, ask to
// fill the field, the approval card shows the field's current and proposed value; approving writes the
// customer and the final answer follows; rejecting leaves the field as it was.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { APIRequestContext } from '@playwright/test'
import { TEST_MODEL_PRICING } from './agent-fake.ts'
import { serverEnv } from './env.ts'
import { bearer, expect, msg, signIn, test, type Page } from './fixtures.ts'

const MODEL = 'e2e-fake-model'
const PROVIDER = 'E2E fake model'
const APPROVED = 'E2E：已按确认补齐。'
const REJECTED = 'E2E：你拒绝了这次修改，没有改动数据。'

/** What the fake model proposes in the next conversation: one field of one customer. */
let script: { id: number; field: string; value: string } | null = null

interface WireMessage {
  role: string
  content?: unknown
}
interface WireBody {
  stream?: boolean
  messages: WireMessage[]
  tools?: { function: { name: string } }[]
}

const chunk = (delta: object, finish: string | null = null) => ({
  id: 'chatcmpl-e2e',
  object: 'chat.completion.chunk',
  created: Math.floor(Date.now() / 1000),
  model: MODEL,
  choices: [{ index: 0, delta, finish_reason: finish }],
})
const USAGE = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }

/** One scripted answer as an SSE stream (the SDK reads `data:` lines up to `[DONE]`). */
function stream(res: ServerResponse, chunks: object[]) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
  res.end('data: [DONE]\n\n')
}

/**
 * `POST /v1/chat/completions`: while the last message is not a tool result, call the update tool (its wire
 * name is taken from the offered tools); after one, answer by what the tool result says (rejected or not).
 */
function handle(req: IncomingMessage, res: ServerResponse) {
  let raw = ''
  req.on('data', (d: Buffer) => (raw += d.toString('utf8')))
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions') || !script) {
      res.writeHead(404).end()
      return
    }
    const body = JSON.parse(raw) as WireBody
    const last = body.messages.at(-1)
    const text =
      last?.role === 'tool'
        ? /rejected/i.test(JSON.stringify(last.content))
          ? REJECTED
          : APPROVED
        : null
    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'chatcmpl-e2e',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: MODEL,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: text ?? '' },
              finish_reason: 'stop',
            },
          ],
          usage: USAGE,
        }),
      )
      return
    }
    if (text !== null) {
      stream(res, [
        chunk({ role: 'assistant', content: '' }),
        chunk({ content: text }),
        chunk({}, 'stop'),
        { ...chunk({}), choices: [], usage: USAGE },
      ])
      return
    }
    const name =
      body.tools?.map((t) => t.function.name).find((n) => /customer.update$/.test(n)) ??
      'demo_customer_update'
    const args = JSON.stringify({ id: script.id, [script.field]: script.value })
    stream(res, [
      chunk({
        role: 'assistant',
        tool_calls: [
          { index: 0, id: 'call_e2e_1', type: 'function', function: { name, arguments: '' } },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }),
      chunk({}, 'tool_calls'),
      { ...chunk({}), choices: [], usage: USAGE },
    ])
  })
}

let fake: Server
let api: APIRequestContext
let providerId: number | undefined
/** root's API session for the whole file (one sign-in, not one per call) */
let headers: Record<string, string>

test.beforeAll(async ({ playwright }) => {
  fake = createServer(handle)
  await new Promise<void>((done) => fake.listen(0, '127.0.0.1', done))
  const { port } = fake.address() as AddressInfo
  // straight to the e2e server (the preview proxy is the browser's way in)
  api = await playwright.request.newContext({ baseURL: `http://127.0.0.1:${serverEnv.PORT}` })
  headers = { Authorization: await bearer(api) }
  const res = await api.post('/api/agent/providers', {
    headers,
    data: {
      name: PROVIDER,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'e2e-dummy-key-not-a-secret',
      models: [{ id: MODEL, pricing: TEST_MODEL_PRICING }],
      isDefault: true,
    },
  })
  expect(res.status(), await res.text()).toBe(201)
  providerId = ((await res.json()) as { data: { id: number } }).data.id
})

test.afterAll(async () => {
  if (providerId !== undefined) await api.delete(`/api/agent/providers/${providerId}`, { headers })
  await api?.dispose()
  await new Promise((done) => fake?.close(done))
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

/** Opens 智能助手 as root, sends `text` and returns the approval card that the update stops on. */
async function askAndWait(page: Page, text: string, c: Customer, value: string) {
  await signIn(page, 'admin', '/agent/chat')
  const composer = page.getByRole('textbox', { name: msg('agent.chat.composer.label') })
  await expect(composer).toBeEnabled()
  await composer.fill(text)
  await page.getByRole('button', { name: msg('agent.chat.composer.send'), exact: true }).click()

  const card = page.getByRole('region', { name: msg('agent.chat.approval.title') })
  await expect(card).toBeVisible({ timeout: 20_000 })
  await expect(card.getByText(`${c.name} (#${c.id})`, { exact: true })).toBeVisible()
  const row = card.getByRole('row').filter({ hasText: 'industry' })
  await expect(row.getByRole('cell').nth(1)).toHaveText(msg('agent.chat.approval.empty'))
  await expect(row.getByRole('cell').nth(2)).toHaveText(value)
  // nothing is written while the card waits
  expect(await industryOf(c.id)).toBeNull()
  return card
}

const answer = (page: Page, text: string) =>
  page.getByRole('log', { name: msg('agent.chat.messages') }).getByText(text)

test('approve: the update waits on its card, then writes the empty field and the answer follows', async ({
  page,
}) => {
  const c = await emptyCustomer('华为技术有限公司')
  script = { id: c.id, field: 'industry', value: '通信设备' }
  const card = await askAndWait(page, `补齐 ${c.name} 的行业`, c, '通信设备')

  await card
    .getByRole('button', { name: msg('agent.chat.approval.action.approve'), exact: true })
    .click()
  await expect(answer(page, APPROVED)).toBeVisible({ timeout: 20_000 })
  await expect(
    card.getByText(msg('agent.chat.approval.decision.approve'), { exact: true }),
  ).toBeVisible()
  await expect.poll(() => industryOf(c.id)).toBe('通信设备')
})

test('reject: the model is told so and the field stays empty', async ({ page }) => {
  const c = await emptyCustomer('美团')
  script = { id: c.id, field: 'industry', value: '本地生活服务' }
  const card = await askAndWait(page, `补齐 ${c.name} 的行业`, c, '本地生活服务')

  await card
    .getByRole('button', { name: msg('agent.chat.approval.action.reject'), exact: true })
    .click()
  await expect(answer(page, REJECTED)).toBeVisible({ timeout: 20_000 })
  expect(await industryOf(c.id)).toBeNull()
})

test('a lost real message acknowledgement is recovered after reload without another model charge or write', async ({
  page,
}) => {
  const c = await emptyCustomer('美团')
  script = { id: c.id, field: 'industry', value: 'Receipt check' }
  let unavailable = true,
    posts = 0
  let accepted: { threadId: number; turnId: number; clientMessageId: string; at: number } | null =
    null
  await page.route(/\/api\/agent\/threads\/\d+\/messages$/, async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    posts++
    const result = await route.fetch()
    const body = await result.json()
    expect(result.status(), JSON.stringify(body)).toBe(201)
    accepted = {
      threadId: Number(
        new URL(route.request().url()).pathname.match(/\/threads\/(\d+)\/messages$/)![1],
      ),
      turnId: Number(body.data.id),
      clientMessageId: route.request().postDataJSON().clientMessageId,
      at: Date.now(),
    }
    // 服务端已经提交接收事务，仅丢浏览器 ACK；不伪造接口数据或模型结算。
    await route.abort('connectionreset')
  })
  await page.route(/\/api\/agent\/threads\/\d+\/messages\/[0-9a-f-]+\/receipt$/, async (route) => {
    if (unavailable) await route.abort('connectionreset')
    else await route.continue()
  })
  try {
    await signIn(page, 'admin', '/agent/chat')
    const composer = page.getByRole('textbox', { name: msg('agent.chat.composer.label') })
    await expect(composer).toBeEnabled()
    await composer.fill('Check this message receipt before changing the customer')
    await page.getByRole('button', { name: msg('agent.chat.composer.send'), exact: true }).click()
    await expect.poll(() => accepted !== null).toBe(true)
    await expect(page.locator('.agent-chat__delivery')).toBeVisible()
    const original = accepted!
    expect(original.clientMessageId).toMatch(/^[0-9a-f-]{36}$/i)
    await expect.poll(() => Date.now() - original.at).toBeGreaterThan(3100)
    unavailable = false
    await page.reload()
    const card = page.getByRole('region', { name: msg('agent.chat.approval.title') })
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.agent-chat__delivery')).toHaveCount(0)
    await expect(composer).toHaveValue('')
    expect(posts).toBe(1)
    const detail = await api.get(`/api/agent/threads/${original.threadId}/items`, { headers })
    expect(detail.ok(), await detail.text()).toBe(true)
    const snapshot = (await detail.json()).data as {
      items: { kind: string; payload: { text?: string } }[]
      turn: { id: number }
    }
    expect(snapshot.items.filter((item) => item.kind === 'user')).toHaveLength(1)
    expect(snapshot.turn.id).toBe(original.turnId)
    const day = new Date().toISOString().slice(0, 10)
    const ledger = await api.get('/api/agent/usage/entries', {
      headers,
      params: { from: day, to: day, page: 1, pageSize: 200 },
    })
    expect(ledger.ok(), await ledger.text()).toBe(true)
    const entries = (await ledger.json()).data.items as {
      turnId: number
      status: string
      credits: string | null
    }[]
    const charged = entries.filter((entry) => entry.turnId === original.turnId)
    expect(charged).toHaveLength(1)
    expect(charged[0]!.status).toBe('complete')
    expect(Number(charged[0]!.credits)).toBeGreaterThan(0)
    expect(await industryOf(c.id)).toBeNull()
  } finally {
    const saved = accepted as { threadId: number } | null
    if (saved) {
      await api.post(`/api/agent/threads/${saved.threadId}/cancel`, { headers })
      await api.delete(`/api/agent/threads/${saved.threadId}`, { headers })
    }
  }
})
