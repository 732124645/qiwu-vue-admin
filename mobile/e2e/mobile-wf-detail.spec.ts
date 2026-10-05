// Approval detail on the H5 build: an instance's head, form (a custom form's mobile view page
// through the view registry, else "view it on a computer"; the registry's summary of its key fields) and
// timeline over the detail API, my pending step after it; the leave view page (pages-biz/leave/view); an
// unrelated user opening another's instance or leave by id → the 404 page (the web's access rule); en-US
// labels, actions, states, model and step names.
import { expect, test, type Page } from '@playwright/test'
import { clientIp, serverScript, signIn, tab, type User } from './env'

/** role `demo`: the initiator, the approver holding a task on it, and a user with no part in it */
const OWNER: User = { username: 'm_wfd_owner', password: 'E2e-Pass@2026' }
const BOSS: User = { username: 'm_wfd_boss', password: 'E2e-Pass@2026' }
const STRANGER: User = { username: 'm_wfd_other', password: 'E2e-Pass@2026' }
const COMMENT = 'Get well soon'
const REASON = 'Flu, doctor says rest'
const DYN_MODEL = 'M-wfd expense claim'

// Straight into the throwaway database (no admin sign-in: the sign-in rate limit is shared by the suite): a
// 3-day sick leave on the seeded process `leave` (a custom form, view_component biz/leave/view) with its
// timeline (the owner's start, the boss's approval with a comment, a system copy to the boss, the boss's
// send-back from the director step to the supervisor step) and the boss's pending task; an instance of a
// dynamic-form model. Prints the ids.
const SEED = `
import { DataSource } from 'typeorm'
import { dataSourceOptions } from './dist/db/data-source.js'
import { seedLimitedUser } from './dist/db/seeds/iam/iam.seed.js'
import { insertRow } from './dist/db/seeds/upsert.js'
const { OWNER, BOSS, STRANGER, COMMENT, REASON, DYN_MODEL } = process.env
const ds = await new DataSource(dataSourceOptions()).initialize()
try {
  await ds.transaction(async (q) => {
    const user = (u) => seedLimitedUser(q, JSON.parse(u).username, JSON.parse(u).password)
    const owner = await user(OWNER)
    const boss = await user(BOSS)
    await user(STRANGER)
    // a worker restarted after a failure seeds again: start over
    await q.query('DELETE FROM wf_event WHERE instance_id IN (SELECT id FROM wf_instance WHERE initiator_id = ?)', [owner])
    await q.query('DELETE FROM wf_task WHERE assignee_id = ?', [boss])
    await q.query('DELETE FROM wf_instance WHERE initiator_id = ?', [owner])
    await q.query('DELETE FROM biz_leave_request WHERE user_id = ?', [owner])
    await q.query("DELETE FROM wf_version WHERE model_key = 'm_wfd_dyn'")
    await q.query("DELETE FROM wf_model WHERE model_key = 'm_wfd_dyn'")
    const [version] = await q.query(
      "SELECT id, tree_json AS tree, form_snapshot AS form FROM wf_version WHERE model_key = 'leave' AND deleted_at IS NULL ORDER BY version DESC LIMIT 1",
    )
    // noon UTC: the same start date in the title whatever the reader's time zone
    const at = (day, hour = 12) => new Date(Date.UTC(2026, 8, day, hour))
    const instance = (versionId, modelKey, businessKey) =>
      insertRow(q, 'wf_instance', {
        version_id: versionId, model_key: modelKey, business_key: businessKey, initiator_id: owner,
        state: 'running', form_values: '{}', initiator_picks: '{}', initiator_ctx: '{}',
        active_node_ids: '[]', started_at: at(1),
      })
    const leave = await insertRow(q, 'biz_leave_request', {
      user_id: owner, leave_kind: 'sick', start_at: at(2, 1), end_at: at(4, 10), days: 3,
      reason: REASON, state: 'in_review', created_at: at(1),
    })
    const id = await instance(version.id, 'leave', String(leave))
    await q.query('UPDATE biz_leave_request SET instance_id = ? WHERE id = ?', [id, leave])
    const event = (hour, action, nodeId, actorId, more = {}) =>
      insertRow(q, 'wf_event', {
        instance_id: id, node_id: nodeId, actor_id: actorId, action, created_at: at(1, hour), ...more,
      })
    await event(12, 'begin', 'begin', owner)
    await event(13, 'approve', 'supervisor', boss, { comment: COMMENT })
    await event(14, 'cc', 'director', null, { target_ids: [boss] })
    await event(15, 'send_back', 'director', boss, { target_ids: ['supervisor'] })
    await insertRow(q, 'wf_task', {
      instance_id: id, node_id: 'director', node_name: 'seed.wf.node.director', assignee_id: boss,
      created_at: at(1, 15),
    })
    const model = await insertRow(q, 'wf_model', {
      model_key: 'm_wfd_dyn', name: DYN_MODEL, form_kind: 'dynamic', draft_json: version.tree,
    })
    const dyn = await insertRow(q, 'wf_version', {
      // the leave tree's conditions need the leave fields: the version must compile, as a published one does
      model_id: model, model_key: 'm_wfd_dyn', version: 1, tree_json: version.tree,
      form_snapshot: version.form,
    })
    await q.query('UPDATE wf_model SET current_version_id = ? WHERE id = ?', [dyn, model])
    console.log(JSON.stringify({ leave, instance: id, dynamic: await instance(dyn, 'm_wfd_dyn', null) }))
  })
} finally {
  await ds.destroy()
}
`
let ids: { leave: number; instance: number; dynamic: number }

test.beforeAll(() => {
  const out = serverScript(SEED, {
    OWNER: JSON.stringify(OWNER),
    BOSS: JSON.stringify(BOSS),
    STRANGER: JSON.stringify(STRANGER),
    COMMENT,
    REASON,
    DYN_MODEL,
  })
  ids = JSON.parse(out.trim().split('\n').pop()!)
})
// each test signs in: outside the suite's shared per-IP sign-in limit
test.beforeEach(({ page }) => page.setExtraHTTPHeaders({ 'X-Forwarded-For': clientIp() }))

const detailUrl = (id: number) => `/#/pages-wf/detail/index?id=${id}`
const leaveUrl = (id: number) => `/#/pages-biz/leave/view?id=${id}`
const steps = (page: Page) => page.locator('.qw-tl__item:not(.is-pending)')
const cell = (page: Page, name: string) => page.locator('.wd-cell', { hasText: name })
const kv = (page: Page, name: string) => page.locator('.qw-kv', { hasText: name })

test('the initiator: head, timeline, the leave form through the registry, a dynamic form on the desktop', async ({
  page,
}) => {
  await page.goto('/')
  await signIn(page, OWNER)
  await tab(page, '审批').click()
  await page.locator('.qw-seg__item', { hasText: '我发起的' }).click()
  await page.locator('.qw-approval__item', { hasText: '请假审批' }).click()
  await expect(page).toHaveURL(new RegExp(`#/pages-wf/detail/index\\?id=${ids.instance}$`))
  await expect(page).toHaveTitle('审批详情')

  // head: the process, its state, who started it when; nothing waits on the owner
  await expect(page.locator('.qw-wf__title')).toHaveText('请假审批')
  await expect(page.locator('.qw-wf__state')).toHaveText('审批中')
  await expect(page.locator('.qw-wf__meta')).toHaveText(
    new RegExp(`^${OWNER.username} 发起于 2026-09-01 \\d\\d:\\d\\d$`),
  )
  await expect(page.locator('.qw-wf__turn')).toHaveCount(0)

  // timeline, oldest first: actor (none: the system), action, step (tx), targets, comment
  await expect(page.locator('.qw-wf__heading')).toHaveText('审批记录')
  await expect(steps(page)).toHaveCount(4)
  for (const text of [OWNER.username, '发起', '发起人']) await expect(steps(page).nth(0)).toContainText(text)
  // §12.4: a detail keeps the full time (lists: the short one)
  await expect(steps(page).locator('.qw-tl__time')).toHaveText(
    Array(4).fill(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
  )
  for (const text of [BOSS.username, '通过', '主管审批', COMMENT])
    await expect(steps(page).nth(1)).toContainText(text)
  for (const text of ['系统', '抄送', '总监审批', `→ ${BOSS.username}`])
    await expect(steps(page).nth(2)).toContainText(text)
  for (const text of [BOSS.username, '退回', '总监审批', '→ 主管审批'])
    await expect(steps(page).nth(3)).toContainText(text)

  await expect(page.locator('.qw-tl__item.is-pending')).toHaveCount(0)

  // the form: model leave's summary (view registry), its page (view_component → pages-biz/leave/view)
  // read-only, no way back to the detail
  await expect(page.locator('.qw-wf__summary .qw-wf__box-title')).toHaveText('请假单')
  await expect(page.locator('.qw-kv .qw-kv__k')).toHaveText([
    '请假类型',
    '开始时间',
    '结束时间',
    '请假天数',
    '请假事由',
  ])
  for (const [name, value] of [
    ['请假类型', '病假'],
    ['开始时间', '2026-09-0'],
    ['请假天数', '3'],
    ['请假事由', REASON],
  ])
    await expect(kv(page, name!)).toContainText(value!)
  await expect(page.locator('.qw-wf__form')).toHaveCount(0)
  await page.locator('.qw-wf__full').click()
  await expect(page).toHaveURL(
    new RegExp(`#/pages-biz/leave/view\\?id=${ids.leave}&readonly=1$`),
  )
  await expect(page).toHaveTitle('请假详情')
  for (const [name, value] of [
    ['状态', '审批中'],
    ['请假类型', '病假'],
    ['请假天数', '3.0'],
    ['开始时间', '2026-09-0'],
    ['请假事由', REASON],
  ])
    await expect(cell(page, name).first()).toContainText(value!)
  await expect(page.locator('.qw-leave__flow')).toHaveCount(0)
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`#/pages-wf/detail/index\\?id=${ids.instance}$`))

  // the leave page itself (its owner): also the way to its approval detail
  await page.goto(leaveUrl(ids.leave))
  await expect(cell(page, '请假事由')).toContainText(REASON)
  await page.locator('.qw-leave__flow').click()
  await expect(page).toHaveURL(new RegExp(`#/pages-wf/detail/index\\?id=${ids.instance}$`))
  await expect(page.locator('.qw-wf__title')).toHaveText('请假审批')

  // a dynamic version without a form: viewed on the desktop; no summary, no link
  await page.goto(detailUrl(ids.dynamic))
  await expect(page.locator('.qw-wf__title')).toHaveText(DYN_MODEL)
  await expect(page.locator('.qw-wf__form')).toContainText('表单')
  await expect(page.locator('.qw-wf__form')).toContainText('请在电脑端查看')
  await expect(page.locator('.qw-wf__summary')).toHaveCount(0)
  await page.locator('.qw-wf__form').click()
  await expect(steps(page)).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`#/pages-wf/detail/index\\?id=${ids.dynamic}$`))
})

test('an unrelated user: another\'s instance and leave by id → the 404 page', async ({ page }) => {
  await page.goto('/')
  await signIn(page, STRANGER)
  for (const url of [detailUrl(ids.instance), leaveUrl(ids.leave), detailUrl(999999999)]) {
    // a fresh load each time: the H5 router may take a hash-only change to a page already open as going back
    // to it. The session resumes from its stored refresh token: the first try's 401 is replayed after it.
    await page.goto('about:blank')
    const answer = page.waitForResponse(
      (r) => /\/api\/(wf\/instances|biz\/leaves)\/\d+$/.test(r.url()) && r.status() !== 401,
    )
    await page.goto(url)
    expect((await answer).status()).toBe(404)
    await expect(page.locator('.qw-empty')).toContainText('请求的资源不存在')
    await expect(page.locator('.qw-wf__head, .qw-leave')).toHaveCount(0)
  }
})

test('en-US: the approver sees labels, actions, states, model and step names in English', async ({
  page,
}) => {
  await page.goto('/')
  await page.locator('.qw-login__lang').click()
  await page.locator('.wd-action-sheet__action', { hasText: 'English' }).click()
  await signIn(page, BOSS)
  // the approver (a task on it) may open it
  await page.goto(detailUrl(ids.instance))
  await expect(page).toHaveTitle('Approval detail')
  await expect(page.locator('.qw-wf__title')).toHaveText('Leave approval')
  await expect(page.locator('.qw-wf__state')).toHaveText('In progress')
  await expect(page.locator('.qw-wf__meta')).toContainText(
    `Started by ${OWNER.username} on 2026-09-01`,
  )
  // the approver's turn: in the head and after the timeline
  await expect(page.locator('.qw-wf__turn')).toHaveText('Your turn · Director approval')
  await expect(page.locator('.qw-wf__heading')).toHaveText('Approval history')
  for (const [i, texts] of [
    ['Start', 'Initiator'],
    ['Approve', 'Supervisor approval'],
    ['System', 'CC', 'Director approval'],
    ['Send back', 'Director approval', '→ Supervisor approval'],
  ].entries())
    for (const text of texts) await expect(steps(page).nth(i)).toContainText(text)
  const mine = page.locator('.qw-tl__item.is-pending')
  for (const text of [BOSS.username, 'Pending', 'Director approval']) await expect(mine).toContainText(text)
  await expect(kv(page, 'Leave type')).toContainText('Sick leave')
  await expect(page.locator('.qw-wf__full')).toHaveText('Full form')

  // an approver may read the leave too (the instance access rule)
  await page.locator('.qw-wf__full').click()
  await expect(page).toHaveTitle('Leave request')
  for (const [name, value] of [
    ['State', 'In review'],
    ['Leave type', 'Sick leave'],
    ['Days', '3.0'],
    ['Reason', REASON],
  ])
    await expect(cell(page, name).first()).toContainText(value!)
})
