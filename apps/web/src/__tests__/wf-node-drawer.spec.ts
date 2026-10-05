// WfDesigner's node drawer, part 1 (see docs/design-notes.md#workflow): who a review / notify node goes to (11 kinds),
// sign mode, nobody / initiator-is-reviewer / reject handling, comment required, resubmitTo and the
// timeout reminder with what happens when overdue; edits the node in place.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElInputNumber, ElMessage, ElSelect, ElTreeSelect } from 'element-plus'
import {
  compile,
  type DeptTreeNode,
  type UserOption,
  type WfBeginNode,
  type WfFields,
  type WfNode,
  type WfNotifyNode,
  type WfReviewNode,
} from '@qiwu/shared'
import { dialogs } from '@/core/dialog'
import DialogHost from '@/core/dialog/DialogHost.vue'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import WfNodeDrawer from '@/views/workflow/designer/WfNodeDrawer.vue'
import WfNodeSettings from '@/views/workflow/designer/WfNodeSettings.vue'
import { mockApi, ok } from './mock-api'

const FIELDS: WfFields = { amount: 'number', applicant: 'user', backup: 'user', note: 'string' }
const USERS: UserOption[] = [
  { id: 7, username: 'ann', displayName: 'Ann Lee', deptName: null },
  { id: 8, username: 'bob', displayName: 'Bob Wu', deptName: null },
  { id: 9, username: 'cat', displayName: 'Cat Ng', deptName: null },
]
const DEPTS: DeptTreeNode[] = [
  { id: 1, parentId: 0, name: 'seed.dept.hq', children: [] },
  { id: 2, parentId: 0, name: 'Night shift', children: [] },
]
const review = (): WfReviewNode => ({
  id: 'r1',
  type: 'review',
  name: 'Manager',
  assignee: { kind: 'users', ids: [7] },
  sign: 'any',
  whenNobody: 'toManager',
  whenInitiatorIsReviewer: 'self',
  onReject: 'finish',
})

let calls: ReturnType<typeof mockApi>
let host: VueWrapper
const mounted: VueWrapper[] = []
beforeEach(async () => {
  setLocale('en-US')
  accessToken.value = 'at'
  vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
  calls = mockApi({
    'GET /iam/users/options': ok(USERS),
    'GET /iam/depts/tree': ok(DEPTS),
    'GET /iam/roles/options': ok([
      { id: 2, code: 'member', name: 'seed.role.member' },
      { id: 5, code: 'hr', name: 'HR' },
    ]),
    'GET /iam/positions/options': ok([{ id: 3, name: 'Clerk' }]),
  })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  await router.push('/')
  host = mount(DialogHost, {
    global: { plugins: [ElementPlus, i18n, router], stubs: { transition: false } },
    attachTo: document.body,
  })
})
afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount())
  host.unmount()
  dialogs.splice(0)
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

function mountDrawer<N extends WfNode>(node: N) {
  const n = reactive(node) as N
  const w = mount(WfNodeDrawer, {
    props: { modelValue: true, target: { node: n }, fields: FIELDS },
    global: { plugins: [ElementPlus, i18n] },
    attachTo: document.body,
  })
  mounted.push(w)
  return { w, n }
}
const drawer = () => new DOMWrapper(document.body).find('.wf-node-drawer')
const items = () => drawer().findAll('.el-form-item')
const item = (label: string) =>
  items().find((i) => i.find('.el-form-item__label').text() === label)!
const labels = () =>
  items().map((i) =>
    i.find('.el-form-item__label').exists() ? i.find('.el-form-item__label').text() : '',
  )
async function radio(group: string, label: string) {
  await item(group)
    .findAll('.el-radio')
    .find((r) => r.text() === label)!
    .find('input')
    .setValue(true)
  await flushPromises()
}
const radios = (group: string) =>
  item(group)
    .findAll('.el-radio')
    .map((r) => (r.classes('is-checked') ? `(${r.text()})` : r.text()))
const url = (u: string) => calls.filter((c) => c.url === u).length
/** the option labels of an el-select (its dropdown, teleported, opened by a click) */
async function options(select: VueWrapper) {
  await select.find('.el-select__wrapper').trigger('click')
  await flushPromises()
  const list = new DOMWrapper(document.body).find(
    `#${select.find('input').attributes('aria-controls')}`,
  )
  return list.findAll('.el-select-dropdown__item').map((o) => o.text())
}

describe('WfNodeDrawer: who', () => {
  it('lists the 11 kinds with a hint each; a switch starts over with that kind', async () => {
    const { w, n } = mountDrawer(review())
    await flushPromises()
    expect(drawer().find('.el-drawer__title').text()).toBe('Approver settings')
    expect(radios('Who')).toEqual([
      '(Specific users)',
      'Roles',
      'Positions',
      'Department members',
      'Department heads',
      'Chain of department heads',
      'The initiator',
      'Picked by the initiator',
      "Initiator's department head",
      'User in a form field',
      "Head of a form field's department",
    ])
    expect(item('Who').find('.wf-assignee__hint').text()).toBe('The users picked here.')

    await radio('Who', 'Roles')
    expect(n.assignee).toEqual({ kind: 'roles', ids: [] })
    const select = () => w.findAllComponents(ElSelect).find((s) => s.props('name') === 'roles')!
    expect(url('/iam/roles/options')).toBe(1)
    // seeded role names are keys
    expect(await options(select())).toEqual(['Registered member', 'HR'])
    select().vm.$emit('update:modelValue', [2, 5])
    await flushPromises()
    expect(n.assignee).toEqual({ kind: 'roles', ids: [2, 5] })

    await radio('Who', 'Positions')
    expect(n.assignee).toEqual({ kind: 'positions', ids: [] })
    expect(url('/iam/positions/options')).toBe(1)
    w.findAllComponents(ElSelect)
      .find((s) => s.props('name') === 'positions')!
      .vm.$emit('update:modelValue', [3])
    await flushPromises()
    expect(n.assignee).toEqual({ kind: 'positions', ids: [3] })

    await radio('Who', 'Department heads')
    expect(n.assignee).toEqual({ kind: 'deptHead', ids: [] })
    const depts = w.findComponent(ElTreeSelect)
    expect(depts.attributes('multiple')).toBeUndefined()
    expect(depts.props('multiple')).toBe(true)
    depts.vm.$emit('update:modelValue', [1, 2])
    await flushPromises()
    expect(n.assignee).toEqual({ kind: 'deptHead', ids: [1, 2] })
    await radio('Who', 'Department members')
    expect(n.assignee).toEqual({ kind: 'deptMembers', ids: [] })

    await radio('Who', 'Chain of department heads')
    expect(n.assignee).toEqual({ kind: 'deptHeadChain', levels: 1 })
    w.findComponent(ElInputNumber).vm.$emit('update:modelValue', 3)
    await flushPromises()
    expect(n.assignee).toEqual({ kind: 'deptHeadChain', levels: 3 })

    // form fields of the matching type only; none → said so
    await radio('Who', 'User in a form field')
    expect(n.assignee).toEqual({ kind: 'formFieldUser', field: 'applicant' })
    const field = w.findAllComponents(ElSelect).find((s) => s.props('name') === 'field')!
    expect(await options(field)).toEqual(['applicant', 'backup'])
    field.vm.$emit('update:modelValue', 'backup')
    await flushPromises()
    expect(n.assignee).toEqual({ kind: 'formFieldUser', field: 'backup' })
    await radio('Who', "Head of a form field's department")
    expect(n.assignee).toEqual({ kind: 'formFieldDeptHead' })
    expect(item('Form field').text()).toBe('Form fieldThe form has no department field.')

    for (const [label, kind, hint] of [
      ['The initiator', 'initiator', 'The initiator.'],
      [
        'Picked by the initiator',
        'initiatorPicks',
        'The initiator picks them when starting the process.',
      ],
      [
        "Initiator's department head",
        'initiatorDeptHead',
        "The head of the initiator's department.",
      ],
    ] as const) {
      await radio('Who', label)
      expect(n.assignee).toEqual({ kind })
      expect(item('Who').find('.wf-assignee__hint').text()).toBe(hint)
    }
    expect(labels()).not.toContain('Form field')
  })

  it('specific users: picked in UserPicker, shown by name, removed by their tag', async () => {
    const { n } = mountDrawer(review())
    await flushPromises()
    const tags = () =>
      item('Users')
        .findAll('.el-tag')
        .map((t) => t.text())
    // ids saved earlier are named from the user options
    expect(tags()).toEqual(['Ann Lee'])
    await item('Users').find('.wf-user-ids > .el-button').trigger('click')
    await flushPromises()
    const body = new DOMWrapper(document.body)
    const row = (name: string) =>
      body.findAll('.el-dialog .el-table__row').find((r) => r.text().includes(name))!
    await row('Cat Ng').trigger('click')
    await row('Bob Wu').trigger('click')
    await body
      .findAll('.el-dialog .qw-dialog-footer button')
      .find((b) => b.text() === 'OK')!
      .trigger('click')
    await flushPromises()
    expect(n.assignee.ids).toEqual([7, 9, 8])
    expect(tags()).toEqual(['Ann Lee', 'Cat Ng', 'Bob Wu'])
    await item('Users').findAll('.el-tag__close')[0]!.trigger('click')
    expect(n.assignee.ids).toEqual([9, 8])
  })

  it('specific users of a review: tag order is the approval order, moved by their buttons', async () => {
    const { n } = mountDrawer({ ...review(), assignee: { kind: 'users', ids: [7, 8, 9] } })
    await flushPromises()
    expect(item('Users').find('.wf-assignee__hint').text()).toBe(
      'With "All approve, one after another", they approve in the order shown.',
    )
    const tag = (i: number) => item('Users').findAll('.el-tag')[i]!
    const move = (i: number, label: string) => tag(i).find(`button[aria-label="${label}"]`)
    // none past either end
    expect(move(0, 'Move earlier').exists()).toBe(false)
    expect(move(2, 'Move later').exists()).toBe(false)
    await move(0, 'Move later').trigger('click')
    expect(n.assignee.ids).toEqual([8, 7, 9])
    await move(2, 'Move earlier').trigger('click')
    expect(n.assignee.ids).toEqual([8, 9, 7])
    expect(
      item('Users')
        .findAll('.el-tag')
        .map((t) => t.text()),
    ).toEqual(['Bob Wu', 'Cat Ng', 'Ann Lee'])
  })

  it('a head chain without levels goes up to the top; unticked, it takes a number', async () => {
    const { w, n } = mountDrawer({ ...review(), assignee: { kind: 'deptHeadChain' } })
    await flushPromises()
    const toTop = () => item('Levels').find('.el-checkbox')
    expect(toTop().text()).toBe('All levels, up to the top department')
    expect(toTop().classes()).toContain('is-checked')
    expect(w.findAllComponents(ElInputNumber)).toHaveLength(0)

    await toTop().find('input').setValue(false)
    await flushPromises()
    expect(n.assignee).toEqual({ kind: 'deptHeadChain', levels: 1 })
    w.findComponent(ElInputNumber).vm.$emit('update:modelValue', 4)
    await flushPromises()
    expect(n.assignee).toEqual({ kind: 'deptHeadChain', levels: 4 })

    await toTop().find('input').setValue(true)
    await flushPromises()
    expect(n.assignee).toEqual({ kind: 'deptHeadChain' })
    expect(w.findAllComponents(ElInputNumber)).toHaveLength(0)
  })

  it('a notify (cc) node: name and who only', async () => {
    const node: WfNotifyNode = {
      id: 'n1',
      type: 'notify',
      name: 'CC',
      assignee: { kind: 'initiatorDeptHead' },
    }
    const { n } = mountDrawer(node)
    await flushPromises()
    expect(drawer().find('.el-drawer__title').text()).toBe('CC settings')
    expect(labels()).toEqual(['Name', 'Who'])
    await drawer().find('input[name="name"]').setValue('Finance CC')
    await radio('Who', 'Roles')
    expect(n).toEqual({ ...node, name: 'Finance CC', assignee: { kind: 'roles', ids: [] } })
  })

  it('specific users of a cc node: no order to set', async () => {
    mountDrawer({ id: 'n1', type: 'notify', name: 'CC', assignee: { kind: 'users', ids: [7, 8] } })
    await flushPromises()
    expect(
      item('Users')
        .findAll('.el-tag')
        .map((t) => t.text()),
    ).toEqual(['Ann Lee', 'Bob Wu'])
    expect(item('Users').findAll('.el-tag .wf-user-ids__move')).toHaveLength(0)
    expect(item('Users').find('.wf-assignee__hint').exists()).toBe(false)
  })
})

describe('WfNodeDrawer: review options', () => {
  it('sign, nobody found (a user to hand to), initiator is the approver, rejection, resubmit, comment', async () => {
    const { w, n } = mountDrawer(review())
    await flushPromises()
    expect(labels()).toEqual([
      'Name',
      'Who',
      'Users',
      'With several approvers',
      'When nobody is found',
      'When the approver is the initiator',
      'On rejection',
      'Resubmitted after this step sent it back to the initiator',
      '',
      '',
      'Field access',
    ])
    expect(radios('With several approvers')).toEqual([
      '(Any one approves)',
      'All approve',
      'All approve, one after another',
    ])
    await radio('With several approvers', 'All approve, one after another')
    expect(n.sign).toBe('ordered')

    expect(radios('When nobody is found')).toEqual([
      'Approve automatically',
      '(Hand to the process managers)',
      'Hand to a user',
    ])
    await radio('When nobody is found', 'Hand to a user')
    expect(n.whenNobody).toBe('toUser')
    await item('When nobody is found').find('.el-input-group__append button').trigger('click')
    await flushPromises()
    const body = new DOMWrapper(document.body)
    await body
      .findAll('.el-dialog .el-table__row')
      .find((r) => r.text().includes('Bob Wu'))!
      .trigger('dblclick')
    await flushPromises()
    expect(n.fallbackUserId).toBe(8)
    expect(item('When nobody is found').find('input[readonly]').element).toHaveProperty(
      'value',
      'Bob Wu (bob)',
    )
    // no stale user once another choice is made
    await radio('When nobody is found', 'Approve automatically')
    expect(n.whenNobody).toBe('autoPass')
    expect('fallbackUserId' in n).toBe(false)
    expect(item('When nobody is found').find('.el-input').exists()).toBe(false)

    await radio('When the approver is the initiator', 'Skip')
    expect(n.whenInitiatorIsReviewer).toBe('skip')
    await radio('When the approver is the initiator', 'Hand to the department head')
    expect(n.whenInitiatorIsReviewer).toBe('deptHead')
    await radio('On rejection', 'Send back to the previous step')
    expect(n.onReject).toBe('sendBack')

    // Default restart (not stored until chosen)
    expect(radios('Resubmitted after this step sent it back to the initiator')).toEqual([
      '(Starts over from the first step)',
      'Comes straight back to this step',
    ])
    await radio(
      'Resubmitted after this step sent it back to the initiator',
      'Comes straight back to this step',
    )
    expect(n.resubmitTo).toBe('sender')
    await radio(
      'Resubmitted after this step sent it back to the initiator',
      'Starts over from the first step',
    )
    expect(n.resubmitTo).toBe('restart')

    const comment = drawer()
      .findAll('.el-switch')
      .find((s) => s.text() === 'Comment required')!
    expect(n.commentRequired).toBeUndefined()
    await comment.trigger('click')
    expect(n.commentRequired).toBe(true)
    await comment.trigger('click')
    expect(n.commentRequired).toBe(false)

    const tree: WfBeginNode = { id: 'begin', type: 'begin', name: 'Start', next: n }
    expect(compile(tree, FIELDS).ok).toBe(true)
    void w
  })

  it('a saved hand-to user reads by name; the switches have accessible names', async () => {
    mountDrawer({ ...review(), whenNobody: 'toUser', fallbackUserId: 9 })
    await flushPromises()
    expect(item('When nobody is found').find('input[readonly]').element).toHaveProperty(
      'value',
      'Cat Ng',
    )
    expect(
      drawer()
        .findAll('input[role="switch"]')
        .map((i) => i.attributes('aria-label')),
    ).toEqual(['Comment required', 'Overdue reminder'])
  })

  it('a seeded name (see docs/design-notes.md#i18n) shows translated; left as shown it stays the key', async () => {
    const { n } = mountDrawer({ ...review(), name: 'seed.dept.hq' })
    await flushPromises()
    const shown = i18n.global.t('seed.dept.hq')
    expect(shown).not.toBe('seed.dept.hq')
    const input = drawer().find('input[name="name"]')
    expect(input.element).toHaveProperty('value', shown)
    await input.setValue('Finance')
    expect(n.name).toBe('Finance')
    await input.setValue(shown)
    expect(n.name).toBe('seed.dept.hq')
    // a plain name is kept as typed
    await input.setValue('seed.nope')
    expect(n.name).toBe('seed.nope')
  })

  it('timeout reminder: hours due, an optional repeat; off drops it', async () => {
    const { w, n } = mountDrawer(review())
    await flushPromises()
    const reminder = () =>
      drawer()
        .findAll('.el-switch')
        .find((s) => s.text() === 'Overdue reminder')!
    const numbers = () => w.findAllComponents(ElInputNumber)
    expect(numbers()).toHaveLength(0)

    await reminder().trigger('click')
    expect(n.timeout).toEqual({ hours: 24 })
    expect(drawer().find('.wf-node-settings__hint').text()).toBe(
      'Only reminds the assignees; never approves or rejects on its own.',
    )
    expect(numbers().map((i) => [i.props('name'), i.props('min'), i.props('max')])).toEqual([
      ['hours', 1, 8760],
    ])
    numbers()[0]!.vm.$emit('update:modelValue', 48)
    await flushPromises()
    expect(n.timeout).toEqual({ hours: 48 })

    const repeat = drawer().find('.wf-node-settings__timeout .el-checkbox input')
    await repeat.setValue(true)
    await flushPromises()
    expect(n.timeout).toEqual({ hours: 48, remindEvery: 24 })
    numbers()[1]!.vm.$emit('update:modelValue', 6)
    await flushPromises()
    expect(n.timeout).toEqual({ hours: 48, remindEvery: 6 })
    const tree: WfBeginNode = { id: 'begin', type: 'begin', name: 'Start', next: n }
    expect(compile(tree, FIELDS).ok).toBe(true)

    await repeat.setValue(false)
    await flushPromises()
    expect(n.timeout).toEqual({ hours: 48 })
    await reminder().trigger('click')
    expect('timeout' in n).toBe(false)
    expect(numbers()).toHaveLength(0)
  })

  it('when overdue: remind only drops the action key, three codes written, off drops it all', async () => {
    const { n } = mountDrawer(review())
    await flushPromises()
    const reminder = () =>
      drawer()
        .findAll('.el-switch')
        .find((s) => s.text() === 'Overdue reminder')!
    const group = () => drawer().find('[role="radiogroup"][aria-label="When overdue"]')
    const after = () =>
      group()
        .findAll('.el-radio')
        .map((r) => (r.classes('is-checked') ? `(${r.text()})` : r.text()))
    const pick = async (label: string) => {
      await group()
        .findAll('.el-radio')
        .find((r) => r.text() === label)!
        .find('input')
        .setValue(true)
      await flushPromises()
    }
    const hints = () =>
      drawer()
        .findAll('.wf-node-settings__hint')
        .map((h) => h.text())
    const common =
      'Handled within about 5 minutes after the due time; the initiator, the process managers and the ' +
      "to-do's original assignee are notified."
    expect(group().exists()).toBe(false)

    await reminder().trigger('click')
    expect(after()).toEqual([
      '(Remind only)',
      'Approve automatically',
      'Reject automatically',
      'Hand to the manager',
    ])
    expect(hints()).toEqual(['Only reminds the assignees; never approves or rejects on its own.'])

    await pick('Approve automatically')
    expect(n.timeout).toEqual({ hours: 24, action: 'autoPass' })
    expect(hints()).toEqual([
      "Approved on the assignee's behalf; an automatic approval cannot be withdrawn.",
      common,
    ])

    // the reject hint follows the node's "On rejection"
    await pick('Reject automatically')
    expect(n.timeout).toEqual({ hours: 24, action: 'autoReject' })
    expect(hints()[0]).toBe(
      'Rejected on the assignee\'s behalf, as this step\'s "On rejection" says: End the process.',
    )
    await radio('On rejection', 'Send back to the previous step')
    expect(hints()[0]).toBe(
      'Rejected on the assignee\'s behalf, as this step\'s "On rejection" says: Send back to the previous step.',
    )

    await pick('Hand to the manager')
    expect(n.timeout).toEqual({ hours: 24, action: 'toManager' })
    expect(hints()).toEqual([
      "The task is transferred to the head of the assignee's department, or the parent department's head if the assignee is the department head. If no suitable person is found, it is transferred to the process managers. If none is available, only a reminder is sent.",
      common,
    ])
    const tree: WfBeginNode = { id: 'begin', type: 'begin', name: 'Start', next: n }
    expect(compile(tree, FIELDS).ok).toBe(true)

    await pick('Remind only')
    expect(n.timeout).toEqual({ hours: 24 })
    expect('action' in n.timeout!).toBe(false)

    // off drops the whole timeout with its action; back on starts at remind only
    await pick('Approve automatically')
    await reminder().trigger('click')
    expect('timeout' in n).toBe(false)
    expect(group().exists()).toBe(false)
    await reminder().trigger('click')
    expect(n.timeout).toEqual({ hours: 24 })
    expect(after()[0]).toBe('(Remind only)')
  })
})

describe('WfNodeSettings', () => {
  it('the form works without the drawer (the BPMN panel hosts it): edits the node in place', async () => {
    const n = reactive(review())
    const w = mount(WfNodeSettings, {
      props: { target: { node: n }, fields: FIELDS },
      global: { plugins: [ElementPlus, i18n] },
      attachTo: document.body,
    })
    mounted.push(w)
    await flushPromises()
    expect(document.querySelector('.el-drawer')).toBeNull()
    expect(w.findAll('.el-form-item__label').map((l) => l.text())).toContain('On rejection')
    await w.find('input[name="name"]').setValue('Lead')
    await w
      .findAll('.el-radio')
      .find((r) => r.text() === 'All approve')!
      .find('input')
      .setValue(true)
    await flushPromises()
    expect(n).toMatchObject({ name: 'Lead', sign: 'all' })
  })
})
