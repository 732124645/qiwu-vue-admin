// The approval specs' shared helpers (decisions, routing and lifecycle actions): the seeded OA users with a known password, a dynamic
// model whose one step wants a comment, the employee's leave request (process `leave`: supervisor →
// director), and driving the approval detail's action bar and sheets.
import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { clientIp, data, serverScript, signIn, type Headers, type User } from './env'

const PASSWORD = 'E2e-Pass@2026'
const oa = (who: string): User => ({ username: `oa.${who}`, password: PASSWORD })
export const [EMPLOYEE, SUPERVISOR, DEPUTY, DIRECTOR] = [
  'employee',
  'supervisor',
  'deputy',
  'director',
].map(oa) as [User, User, User, User]
/** a dynamic model whose one step, the supervisor's, wants a comment */
export const NOTE_MODEL = 'm_wf_note'
export const NOTE_STEP = 'M-wf check'

// Straight into the throwaway database: the seeded OA users (a random password to change) get a known one,
// counted as changed; the note model (once per database).
const SEED = `
import bcrypt from 'bcryptjs'
import { compile } from '@qiwu/shared'
import { DataSource } from 'typeorm'
import { dataSourceOptions } from './dist/db/data-source.js'
import { insertRow } from './dist/db/seeds/upsert.js'
const { PASSWORD, USERNAMES, MODEL, CHECK } = process.env
const ds = await new DataSource(dataSourceOptions()).initialize()
try {
  await ds.transaction(async (q) => {
    const hash = await bcrypt.hash(PASSWORD, 4)
    await q.query('UPDATE iam_user SET password_hash = ?, password_changed_at = NOW(3) WHERE username IN (?)', [
      hash, JSON.parse(USERNAMES),
    ])
    if ((await q.query('SELECT id FROM wf_model WHERE model_key = ?', [MODEL])).length) return
    const [sup] = await q.query("SELECT id FROM iam_user WHERE username = 'oa.supervisor'")
    const r = compile({ id: 'begin', type: 'begin', name: 'Begin', next: {
      id: 'check', type: 'review', name: CHECK, assignee: { kind: 'users', ids: [sup.id] }, sign: 'any',
      whenNobody: 'autoPass', whenInitiatorIsReviewer: 'self', onReject: 'finish', commentRequired: true,
    } }, {})
    if (!r.ok) throw new Error(JSON.stringify(r))
    const model = await insertRow(q, 'wf_model', {
      model_key: MODEL, name: 'M-wf note', form_kind: 'dynamic', draft_json: r.flow.root,
    })
    const version = await insertRow(q, 'wf_version', {
      model_id: model, model_key: MODEL, version: 1, tree_json: r.flow.root, form_snapshot: { fields: {} },
    })
    await q.query('UPDATE wf_model SET current_version_id = ? WHERE id = ?', [version, model])
  })
} finally {
  await ds.destroy()
}
`

/** The known passwords and the note model (for `test.beforeAll`). */
export const seedWf = () =>
  serverScript(SEED, {
    PASSWORD,
    USERNAMES: JSON.stringify([EMPLOYEE, SUPERVISOR, DEPUTY, DIRECTOR].map((u) => u.username)),
    MODEL: NOTE_MODEL,
    CHECK: NOTE_STEP,
  })

/** The employee's 3-day leave request (it starts process `leave`: supervisor → director); its instance. */
export async function leave(request: APIRequestContext, headers: Headers, reason: string) {
  const res = request.post('/api/biz/leaves', {
    headers,
    data: {
      leaveKind: 'personal',
      startAt: '2026-12-07T09:00:00+08:00',
      endAt: '2026-12-09T18:00:00+08:00',
      days: 3,
      reason,
    },
  })
  return (await data<{ instanceId: number }>(res)).instanceId
}

/** A user's counts through the API, as the workbench and the tab badges load them. */
export async function counts(request: APIRequestContext, headers: Headers) {
  const todo = await data<{ total: number }>(
    request.get('/api/wf/tasks/todo', { headers, params: { page: 1, pageSize: 1 } }),
  )
  const running = await data<{ total: number }>(
    request.get('/api/wf/instances/mine', {
      headers,
      params: { page: 1, pageSize: 1, state: 'running' },
    }),
  )
  const unread = await data<{ unread: number }>(
    request.get('/api/messaging/inboxes/mine/unread', { headers }),
  )
  return { todo: todo.total, running: running.total, unread: unread.unread }
}

/** The employee starts the note model; its instance. */
export async function startNote(request: APIRequestContext, headers: Headers) {
  const res = request.post('/api/wf/instances', { headers, data: { modelKey: NOTE_MODEL } })
  return (await data<{ id: number }>(res)).id
}

export const detailUrl = (id: number) => `/#/pages-wf/detail/index?id=${id}`
export const bar = (page: Page) => page.locator('.qw-decide-bar')
export const sheet = (page: Page) => page.locator('.qw-decide')
export const submitButton = (page: Page) => page.locator('.qw-decide__submit')
export const comment = (page: Page) => page.locator('.qw-decide__comment textarea')
/** the timeline's events (not my pending step drawn after them) */
export const steps = (page: Page) => page.locator('.qw-tl__item:not(.is-pending)')
export const state = (page: Page) => page.locator('.qw-wf__state')

/** `user` signs in on a fresh app (the previous user's stored session dropped) and opens instance `id`. */
export async function openAs(page: Page, user: User, id: number) {
  // the app is idle (no refresh in flight): nothing writes the session back after this
  if (page.url().startsWith('http')) await page.evaluate(() => localStorage.clear())
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': clientIp() })
  await page.goto('about:blank')
  await page.goto('/')
  await signIn(page, user)
  await page.goto(detailUrl(id))
  await expect(page.locator('.qw-wf__title')).toBeVisible()
}

export const LABEL = {
  approve: '通过',
  reject: '驳回',
  sendBack: '退回',
  transfer: '转办',
  delegate: '委派',
  addSign: '加签',
  cc: '抄送',
  comment: '评论',
  removeSign: '减签',
  withdraw: '撤回',
  cancel: '撤销',
}
export type Action = keyof typeof LABEL

/** Opens action `key`'s sheet from its button in the bar (approve, reject: by default), else under 更多. */
export async function open(page: Page, key: Action, inBar = key === 'approve' || key === 'reject') {
  if (inBar) await page.locator(`.qw-decide-bar__${key}`).click()
  else {
    await page.locator('.qw-decide-bar__more').click()
    await page.locator('.wd-action-sheet__action', { hasText: LABEL[key] }).click()
  }
  await expect(sheet(page)).toBeVisible()
}

/** An action's POST: on a task, or on the instance (cancel, urge). */
export const isActionPost = (r: { url(): string; method(): string }) =>
  r.method() === 'POST' && /\/api\/wf\/(tasks|instances)\/\d+\/[a-z-]+$/.test(r.url())

/** Confirms the open sheet (its rules pass); resolves with the body it posted. */
export async function submit(page: Page) {
  const answered = page.waitForResponse((r) => isActionPost(r.request()))
  await submitButton(page).click()
  const res = await answered
  expect(res.status(), await res.text()).toBe(200)
  await expect(sheet(page)).toBeHidden()
  return res.request().postDataJSON() as unknown
}

/** Picks `name` (display name; an array: several, then confirmed) in the sheet's user field (QwUserPicker). */
export async function pickUser(page: Page, name: string | string[]) {
  const names = [name].flat()
  await page.locator('.qw-decide__user .wd-cell').click()
  const picker = page.locator('.qw-user-picker__sheet')
  await expect(picker).toBeVisible()
  for (const one of names) {
    await picker.locator('.wd-search input').fill(one)
    await picker.locator('.qw-user-picker__user', { hasText: one }).click()
  }
  if (Array.isArray(name)) await picker.locator('.qw-picker__head .wd-button').click()
  await expect(picker).toBeHidden()
  for (const one of names)
    await expect(page.locator('.qw-decide__user .wd-cell')).toContainText(one)
}

/** Counts the actions `page` posts. */
export function countPosts(page: Page) {
  const seen = { n: 0 }
  page.on('request', (r) => void (isActionPost(r) && seen.n++))
  return seen
}
