// Approval lists: each list's API and row shape, the to-do total feeding the shared count, state tags;
// the detail: its API, the form page through the mobile view registry, timeline targets; the
// actions: which ones the caller may take and on what, their bodies and rules, their APIs;
// 发起: the startable models by category, where a card goes, the initiator's picks, the start and resubmit.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { DictPayload, MePayload, WfInstanceItemVo, WfStartableVo } from '@qiwu/shared'
import {
  avatar,
  decide,
  decideBody,
  createPage,
  decideSchema,
  detailActions,
  editPage,
  formPage,
  loadApprovals,
  loadBackTargets,
  loadInstance,
  loadStartable,
  loadStartInfo,
  loadSummary,
  modelIcon,
  mySigns,
  picksMissing,
  readCc,
  startGroups,
  startModel,
  stateTag,
  targetNames,
  urge,
  type DecideForm,
  type WfDecision,
} from '@/core/approvals'
import { formatTime } from '@/core/format'
import { fieldErrors, setLocale } from '@/core/i18n'
import { setSession } from '@/core/request'
import { useAuthStore } from '@/core/stores/auth'
import { useCountsStore } from '@/core/stores/counts'

type Req = UniApp.RequestOptions
let answer: unknown
const calls: Req[] = []

beforeEach(() => {
  setActivePinia(createPinia())
  setSession({ accessToken: 'a1', refreshToken: 'r1', expiresIn: 1800 })
  calls.length = 0
  vi.mocked(uni.request).mockImplementation((o) => {
    calls.push(o)
    o.success?.({ statusCode: 200, data: { code: 0, msg: 'ok', data: answer } } as never)
    return {} as UniApp.RequestTask
  })
})
afterEach(() => setLocale('zh-CN'))

const at = '2026-09-01T08:00:00.000Z'
const instance: WfInstanceItemVo = {
  id: 7,
  modelKey: 'leave',
  modelName: 'seed.wf.leave',
  title: 'Leave-Ann-2026-09-01',
  initiator: { id: 3, name: 'Ann' },
  state: 'running',
  startedAt: at,
  endedAt: null,
}
const task = {
  id: 11,
  nodeId: 'supervisor',
  nodeName: 'seed.wf.node.supervisor',
  state: 'approved',
  comment: 'Fine',
  createdAt: at,
  handledAt: '2026-09-02T08:00:00.000Z',
  instance,
}

it('to-dos: the model, initiator and step; the total is the shared to-do count', async () => {
  answer = { items: [{ ...task, state: 'pending', comment: null, handledAt: null }], total: 23 }
  const page = await loadApprovals('todo', 2, 20)
  expect([calls[0]!.url, calls[0]!.data]).toEqual(['/api/wf/tasks/todo', { page: 2, pageSize: 20 }])
  expect(page).toEqual({
    total: 23,
    items: [
      {
        id: 11,
        instanceId: 7,
        modelName: 'seed.wf.leave',
        initiator: 'Ann',
        initiatorId: 3,
        at,
        node: 'seed.wf.node.supervisor',
        tags: [],
        note: null,
      },
    ],
  })
  expect(useCountsStore().todo).toBe(23)
})

it('done, started and copied lists: their times, states, notes and read state', async () => {
  answer = { items: [task], total: 1 }
  const [done] = (await loadApprovals('done', 1, 20)).items
  expect(calls[0]!.url).toBe('/api/wf/tasks/done')
  expect(done).toMatchObject({
    id: 11,
    instanceId: 7,
    modelName: 'seed.wf.leave',
    initiator: 'Ann',
    initiatorId: 3,
    at: task.handledAt,
    note: 'Fine',
  })
  expect(done!.tags).toEqual([
    { dict: 'wf.task_state', value: 'approved' },
    { dict: 'wf.instance_state', value: 'running' },
  ])
  expect(done!.from).toBeUndefined()

  answer = { items: [{ ...instance, state: 'rejected' }], total: 1 }
  const [mine] = (await loadApprovals('mine', 1, 20)).items
  expect(calls[1]!.url).toBe('/api/wf/instances/mine')
  expect(mine).toMatchObject({ id: 7, instanceId: 7, modelName: 'seed.wf.leave', at, note: null })
  expect(mine!.tags).toEqual([{ dict: 'wf.instance_state', value: 'rejected' }])

  const cc = { id: 5, fromUser: null, reason: null, readAt: null, createdAt: at, instance }
  answer = {
    items: [cc, { ...cc, id: 6, fromUser: { id: 3, name: 'Ann' }, reason: 'FYI', readAt: at }],
    total: 2,
  }
  const [step, sent] = (await loadApprovals('cc', 1, 20)).items
  expect(calls[2]!.url).toBe('/api/wf/ccs/mine')
  // null: a notify step of the process
  expect(step).toMatchObject({
    id: 5,
    instanceId: 7,
    initiator: 'Ann',
    from: null,
    note: null,
    unread: true,
  })
  expect(sent).toMatchObject({ id: 6, from: 'Ann', note: 'FYI', unread: false })
  // only the to-do list moves the shared count
  expect(useCountsStore().todo).toBeNull()

  answer = null
  await readCc(5)
  expect([calls[3]!.url, calls[3]!.method]).toEqual(['/api/wf/ccs/5/read', 'POST'])
})

it('avatars: the first letter upper-cased, a colour by user id, neutral for the system', () => {
  expect(avatar('李娜', 4)).toEqual({ text: '李', tone: 'brand' })
  expect(avatar('ann', 5)).toEqual({ text: 'A', tone: 'success' })
  expect(avatar('Bo', 6).tone).toBe('warning')
  expect(avatar('Cy', 7).tone).toBe('neutral')
  // a surrogate pair stays whole; a user gone; the system
  expect(avatar('\u{20BB7}x', 8).text).toBe('\u{20BB7}')
  expect(avatar(null, 9).text).toBe('?')
  expect(avatar('System', null)).toEqual({ text: 'S', tone: 'neutral' })
})

it('state tags: the dict label in the current language, .qw-tag colours', () => {
  const entry = (value: string, zh: string, en: string, tagType: string) => ({
    value,
    label: 'x',
    labelI18n: { 'zh-CN': zh, 'en-US': en },
    tagType,
    cssClass: null,
    isDefault: false,
    sortNo: 0,
  })
  const dict: DictPayload = {
    version: 1,
    entries: [
      entry('approved', '已通过', 'Approved', 'success'),
      entry('canceled', '已撤销', 'Canceled', 'info'),
    ],
  }
  expect(stateTag(dict, 'approved')).toEqual({ label: '已通过', type: 'success' })
  setLocale('en-US')
  expect(stateTag(dict, 'canceled')).toEqual({ label: 'Canceled', type: 'info' })
  // not loaded (yet) or unknown: the code, neutral
  expect(stateTag(undefined, 'running')).toEqual({ label: 'running', type: 'info' })
})

it('detail: the form page of a mapped custom form, else viewed on the desktop', async () => {
  answer = { id: 7 }
  await loadInstance(7)
  expect([calls[0]!.url, calls[0]!.method]).toEqual(['/api/wf/instances/7', 'GET'])

  const leave = { formKind: 'custom', viewComponent: 'biz/leave/view', businessKey: '4/2' } as const
  expect(formPage(leave)).toBe('/pages-biz/leave/view?id=4%2F2&readonly=1')
  // unmapped (also a prototype key), no business row yet, a dynamic form (rendered by the dynamic form page)
  for (const viewComponent of ['biz/trip/view', 'constructor', null])
    expect(formPage({ ...leave, viewComponent })).toBeNull()
  expect(formPage({ ...leave, businessKey: null })).toBeNull()
  expect(formPage({ ...leave, formKind: 'dynamic' })).toBeNull()

  // sent back to its initiator (begin task 12): a mapped custom form is changed on its edit page, given
  // its modify perm (else resubmitted as it is)
  expect(editPage(leave, 12)).toBeNull()
  useAuthStore().me = { perms: ['biz.leave.modify'] } as MePayload
  expect(editPage(leave, 12)).toBe('/pages-biz/leave/index?id=4%2F2&task=12')
  for (const viewComponent of ['biz/trip/view', 'constructor', null])
    expect(editPage({ ...leave, viewComponent }, 12)).toBeNull()
  expect(editPage({ ...leave, formKind: 'dynamic' }, 12)).toBeNull()
})

it("model icons: the view registry's by view or create route, else a document", () => {
  expect(modelIcon({ viewComponent: 'biz/leave/view' })).toBe('calendar')
  expect(modelIcon({ createRoute: '/biz/leave/new' })).toBe('calendar')
  expect(modelIcon({ viewComponent: null })).toBe('doc')
  expect(modelIcon({ createRoute: null, viewComponent: 'biz/trip/view' })).toBe('doc')
})

it("form summary: a mapped form's document as label and text, dict labels, local times; else none", async () => {
  const leave = { formKind: 'custom', viewComponent: 'biz/leave/view', businessKey: '4' } as const
  const doc = {
    leaveKind: 'annual',
    startAt: '2026-10-08T01:00:00.000Z',
    endAt: '2026-10-10T10:00:00.000Z',
    days: 2.5,
    reason: null,
  }
  const kinds: DictPayload = {
    version: 1,
    entries: [
      {
        value: 'annual',
        label: 'x',
        labelI18n: { 'zh-CN': '年假', 'en-US': 'Annual leave' },
        tagType: null,
        cssClass: null,
        isDefault: false,
        sortNo: 0,
      },
    ],
  }
  vi.mocked(uni.request).mockImplementation((o) => {
    calls.push(o)
    const body = o.url.includes('/settings/dicts/')
      ? kinds
      : o.url.endsWith('/biz/leaves/4')
        ? doc
        : null
    o.success?.({ statusCode: 200, data: { code: 0, msg: 'ok', data: body } } as never)
    return {} as UniApp.RequestTask
  })
  expect(await loadSummary(leave)).toEqual({
    title: '请假单',
    rows: [
      { label: '请假类型', value: '年假' },
      { label: '开始时间', value: formatTime(doc.startAt) },
      { label: '结束时间', value: formatTime(doc.endAt) },
      { label: '请假天数', value: '2.5' },
      { label: '请假事由', value: '' },
    ],
  })
  expect(calls.map((c) => c.url)).toContain('/api/biz/leaves/4')

  // none: unmapped, a dynamic form, no business row; the document not loading (the one form row instead)
  calls.length = 0
  for (const inst of [
    { ...leave, viewComponent: 'biz/trip/view' },
    { ...leave, formKind: 'dynamic' },
    { ...leave, businessKey: null },
  ] as const)
    expect(await loadSummary(inst)).toBeNull()
  expect(calls).toHaveLength(0)
  vi.mocked(uni.request).mockImplementation((o) => {
    o.success?.({ statusCode: 404, data: { code: 404, msg: 'gone', data: null } } as never)
    return {} as UniApp.RequestTask
  })
  expect(await loadSummary(leave)).toBeNull()
})

it('timeline targets: users by name, a send-back step by its translated name, else the id', () => {
  const event = {
    id: 1,
    action: 'send_back',
    nodeId: 'director',
    nodeName: 'seed.wf.node.director',
    actor: null,
    comment: null,
    createdAt: at,
    targets: [
      { id: 'begin', name: 'seed.wf.node.begin' },
      { id: 3, name: 'Ann' },
      { id: 9, name: null },
    ],
  } as const
  expect(targetNames({ ...event, targets: [...event.targets] })).toBe('发起人, Ann, 9')
  setLocale('en-US')
  expect(targetNames({ ...event, targets: [...event.targets] })).toBe('Initiator, Ann, 9')
})

const myTask = {
  id: 5,
  nodeId: 'supervisor',
  nodeName: 'seed.wf.node.supervisor',
  commentRequired: false,
}
const nothing = {
  id: 7,
  myTasks: [],
  signs: [],
  withdrawable: null,
  canCancel: false,
  canUrge: false,
}
const sign = (id: number, parentTaskId: number) => ({
  id,
  parentTaskId,
  nodeName: `node ${parentTaskId}`,
  user: { id: id * 10, name: `U${id}` },
})

it('actions: my oldest review task (a child one approves, copies and comments), then my signs, approval, instance', () => {
  const begin = { ...myTask, id: 4, nodeId: 'begin', type: 'begin', child: false } as const
  const review = { ...myTask, type: 'review', child: false } as const
  const acts = (more: Partial<Parameters<typeof detailActions>[0]>) =>
    detailActions({ ...nothing, ...more }).map((x) => x.action)
  expect(acts({})).toEqual([])
  // sent back to me, the initiator: resubmit (my begin task), before cancel (the bar's last two)
  expect(detailActions({ ...nothing, myTasks: [begin] })).toEqual([
    { action: 'resubmit', id: 4, node: 'seed.wf.node.supervisor', commentRequired: false },
  ])
  expect(acts({ myTasks: [begin], canUrge: true, canCancel: true })).toEqual([
    'urge',
    'resubmit',
    'cancel',
  ])
  const required = { ...review, commentRequired: true }
  const all = detailActions({ ...nothing, myTasks: [required, { ...review, id: 6 }] })
  expect(all.map((x) => x.action)).toEqual([
    'approve',
    'reject',
    'sendBack',
    'transfer',
    'delegate',
    'addSign',
    'cc',
    'comment',
  ])
  // all on my oldest one
  expect(all.every((x) => x.id === 5 && x.commentRequired)).toBe(true)
  expect(all[0]).toEqual({
    action: 'approve',
    id: 5,
    node: 'seed.wf.node.supervisor',
    commentRequired: true,
  })
  expect(acts({ myTasks: [{ ...review, child: true }] })).toEqual(['approve', 'cc', 'comment'])

  // remove-sign on the parent of my first signs; withdraw on my approval; urge and cancel on the instance
  const signs = [sign(21, 9), sign(22, 8), sign(23, 9)]
  expect(mySigns({ signs }).map((s) => s.id)).toEqual([21, 23])
  const rest = detailActions({
    ...nothing,
    signs,
    withdrawable: { id: 3, nodeName: 'seed.wf.node.director' },
    canUrge: true,
    canCancel: true,
  })
  expect(rest).toEqual([
    { action: 'removeSign', id: 9, node: 'node 9', commentRequired: false },
    { action: 'withdraw', id: 3, node: 'seed.wf.node.director', commentRequired: false },
    { action: 'urge', id: 7, node: '', commentRequired: false },
    { action: 'cancel', id: 7, node: '', commentRequired: false },
  ])
  expect(acts({ myTasks: [review], canCancel: true }).slice(-2)).toEqual(['comment', 'cancel'])
})

const form = (more: Partial<DecideForm> = {}): DecideForm => ({
  comment: '',
  to: '',
  user: [],
  kind: 'before',
  taskIds: [],
  ...more,
})
const check = (action: WfDecision, f: DecideForm, required = false) => {
  const { body, issues } = decideBody(action, f, required)
  return body ?? fieldErrors(decideSchema(action), issues)
}
const user = [{ id: 9, displayName: 'Deputy', deptName: null }]

it('decision bodies: the shared schemas; a commentRequired step wants a comment to approve or reject', () => {
  // blank comments are left out; the other actions' fields are not posted
  expect(check('approve', form({ comment: '  ', to: 'x', user, taskIds: [1] }))).toEqual({})
  expect(check('reject', form({ comment: ' Too long ' }))).toEqual({ comment: 'Too long' })
  for (const action of ['approve', 'reject'] as const) {
    expect(check(action, form(), true)).toEqual({ comment: '意见不能为空' })
    expect(check(action, form({ comment: ' ok ' }), true)).toEqual({ comment: 'ok' })
  }
  // only approve and reject want it
  expect(check('sendBack', form({ to: 'supervisor' }), true)).toEqual({ to: 'supervisor' })
  expect(check('sendBack', form())).toEqual({ to: '退回节点不能为空' })
  for (const action of ['transfer', 'delegate'] as const) {
    expect(check(action, form())).toEqual({ userId: '目标人员不能为空' })
    expect(check(action, form({ user, comment: 'yours' }), true)).toEqual({
      userId: 9,
      comment: 'yours',
    })
  }
  expect(check('approve', form({ comment: 'x'.repeat(1001) }))).toEqual({
    comment: '意见最多 1000 个字符',
  })
  setLocale('en-US')
  expect(check('transfer', form())).toEqual({ userId: 'User is required' })
})

it('routing and lifecycle bodies: add-sign after approves (a required comment), cc notes, comment, remove-sign, withdraw, cancel', () => {
  const two = [...user, { id: 10, displayName: 'Director', deptName: null }]
  expect(check('addSign', form())).toEqual({ userIds: '人员至少 1 项' })
  // before holds my task: no approval, no comment wanted
  expect(check('addSign', form({ user: two }), true)).toEqual({ kind: 'before', userIds: [9, 10] })
  expect(check('addSign', form({ user: two, kind: 'after' }), true)).toEqual({
    comment: '意见不能为空',
  })
  expect(check('addSign', form({ user, kind: 'after' }))).toEqual({ kind: 'after', userIds: [9] })
  expect(check('addSign', form({ user, kind: 'after', comment: ' ok ' }), true)).toEqual({
    kind: 'after',
    userIds: [9],
    comment: 'ok',
  })
  // cc's note is its reason
  expect(check('cc', form({ user: two, comment: ' fyi ' }))).toEqual({
    userIds: [9, 10],
    reason: 'fyi',
  })
  expect(check('cc', form({ user, comment: 'x'.repeat(1001) }))).toEqual({
    reason: '抄送说明最多 1000 个字符',
  })
  expect(check('comment', form())).toEqual({ comment: '意见不能为空' })
  expect(check('comment', form({ comment: ' hi ' }))).toEqual({ comment: 'hi' })
  expect(check('removeSign', form())).toEqual({ taskIds: '加签任务至少 1 项' })
  expect(check('removeSign', form({ taskIds: [21, 23], comment: 'no' }))).toEqual({
    taskIds: [21, 23],
    comment: 'no',
  })
  // no approval: never a required comment
  for (const action of ['withdraw', 'cancel'] as const) {
    expect(check(action, form({ user, to: 'x' }), true)).toEqual({})
    expect(check(action, form({ comment: 'why' }))).toEqual({ comment: 'why' })
  }
})

it('action APIs: POST /wf/tasks/:id/<action>, cancel and urge on the instance, the back targets', async () => {
  answer = null
  const TASK = [
    'approve',
    'reject',
    'sendBack',
    'transfer',
    'delegate',
    'addSign',
    'cc',
    'comment',
    'removeSign',
    'withdraw',
    'resubmit',
  ] as const
  for (const action of TASK) await decide(5, action, { comment: 'c' })
  await decide(7, 'cancel', { comment: 'c' })
  const PATHS = [
    'approve',
    'reject',
    'send-back',
    'transfer',
    'delegate',
    'add-sign',
    'cc',
    'comment',
    'remove-sign',
    'withdraw',
    'resubmit',
  ]
  expect(calls.map((c) => [c.method, c.url, c.data])).toEqual([
    ...PATHS.map((p) => ['POST', `/api/wf/tasks/5/${p}`, { comment: 'c' }]),
    ['POST', '/api/wf/instances/7/cancel', { comment: 'c' }],
  ])
  calls.length = 0
  answer = [{ id: 'begin', name: 'seed.wf.node.begin', type: 'begin' }]
  expect(await loadBackTargets(5)).toEqual(answer)
  expect([calls[0]!.method, calls[0]!.url]).toEqual(['GET', '/api/wf/tasks/5/back-targets'])

  // urge: silent, its 429 is the page's to tell
  vi.mocked(uni.showToast).mockClear()
  vi.mocked(uni.request).mockImplementation((o) => {
    calls.push(o)
    o.success?.({ statusCode: 429, data: { code: 1, msg: 'Too many', data: null } } as never)
    return {} as UniApp.RequestTask
  })
  await expect(urge(7)).rejects.toMatchObject({ status: 429 })
  expect([calls[1]!.method, calls[1]!.url]).toEqual(['POST', '/api/wf/instances/7/urge'])
  expect(uni.showToast).not.toHaveBeenCalled()
})

const model = (modelKey: string, category: string, more: Partial<WfStartableVo> = {}) => ({
  modelKey,
  name: modelKey,
  category,
  icon: null,
  description: null,
  formKind: 'dynamic' as const,
  createRoute: null,
  ...more,
})

it('发起: the startable models by category in the dict order, where a custom card goes', async () => {
  answer = [model('a', 'finance'), model('b', 'hr'), model('c', 'lab'), model('d', 'finance')]
  const models = await loadStartable()
  expect([calls[0]!.method, calls[0]!.url]).toEqual(['GET', '/api/wf/startable-models'])
  const dict = {
    code: 'wf.category',
    entries: [
      { value: 'hr', label: 'hr', labelI18n: { 'zh-CN': '人事', 'en-US': 'HR' } },
      { value: 'finance', label: 'finance', labelI18n: { 'zh-CN': '财务', 'en-US': 'Finance' } },
    ],
  } as unknown as DictPayload
  const groups = (d?: DictPayload) =>
    startGroups(models, d).map((g) => [g.label, g.models.map((m) => m.modelKey)])
  // a category the dict lacks last, as its code
  expect(groups(dict)).toEqual([
    ['人事', ['b']],
    ['财务', ['a', 'd']],
    ['lab', ['c']],
  ])
  setLocale('en-US')
  expect(groups(dict)[0]).toEqual(['HR', ['b']])
  // the dict not loaded (yet): the models' order
  expect(groups().map(([label]) => label)).toEqual(['finance', 'hr', 'lab'])

  // a custom model: its mobile create page by create_route, else the desktop
  expect(createPage({ createRoute: '/biz/leave/new' })).toBe('/pages-biz/leave/index')
  for (const createRoute of ['/biz/trip/new', 'constructor', null])
    expect(createPage({ createRoute })).toBeNull()
})

it('发起: the steps whose users the initiator picks, each needs somebody; the start posts their ids', async () => {
  answer = { picks: [] }
  await loadStartInfo('m/1')
  expect([calls[0]!.method, calls[0]!.url]).toEqual(['GET', '/api/wf/models/m%2F1/start-info'])
  const picks = [
    { id: 'lead', name: 'seed.wf.node.supervisor', type: 'review' as const },
    { id: 'copy', name: 'Copy', type: 'notify' as const },
  ]
  expect(picksMissing(picks, { lead: [], copy: user })).toEqual({
    lead: '请选择节点 主管审批 的人员',
  })
  expect(picksMissing(picks, {})).toEqual({
    lead: '请选择节点 主管审批 的人员',
    copy: '请选择节点 Copy 的人员',
  })
  expect(picksMissing(picks, { lead: user, copy: user })).toEqual({})

  answer = { id: 30, state: 'running' }
  const two = [...user, { id: 10, displayName: 'Director', deptName: null }]
  expect(await startModel('m1', { lead: two, copy: user })).toEqual(answer)
  expect([calls[1]!.method, calls[1]!.url, calls[1]!.data]).toEqual([
    'POST',
    '/api/wf/instances',
    { modelKey: 'm1', initiatorPicks: { lead: [9, 10], copy: [9] } },
  ])
  // a model with a form sends its values too
  await startModel('m2', {}, { reason: 'x', days: 2 })
  expect(calls[2]!.data).toEqual({
    modelKey: 'm2',
    initiatorPicks: {},
    formValues: { reason: 'x', days: 2 },
  })
})
