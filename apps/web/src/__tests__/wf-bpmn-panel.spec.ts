// The BPMN settings panel. `element-node.ts` maps an element to what
// the panel edits (the tree designer's `Target`, else a name) and back to what is written on it (`written`):
// `qw:Config` = the node's settings, a flow's `qw-rule` condition = its path's `when`, the gateway's `default` =
// the fallback path, `flowElements` order = path order. WfBpmnPanel edits a copy and hands each burst of edits
// on once (one undo step), re-reads after outside changes, lists a fork's paths for reordering and adds one.
// bpmn-js does not run here: elements are plain objects shaped like diagram-js ones.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import type { WfFields, WfForkPath, WfReviewNode } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import WfBpmnPanel from '@/views/workflow/bpmn/WfBpmnPanel.vue'
import {
  branchesOf,
  editOf,
  written,
  type Item,
  type Written,
} from '@/views/workflow/bpmn/element-node'
import type { Target } from '@/views/workflow/designer/tree'
import type { Bo } from '@/views/workflow/bpmn/helpers'
import { mockApi, ok } from './mock-api'

const FIELDS: WfFields = { amount: 'number', note: 'string' }
const REVIEW = {
  assignee: { kind: 'users', ids: [7] },
  sign: 'any',
  whenNobody: 'toManager',
  whenInitiatorIsReviewer: 'self',
  onReject: 'finish',
}
const BIG = [[{ field: 'amount', op: 'gt', value: 1000 }]]

/** A process of plain elements; `flowElements` keeps the order they are made in. */
function diagram() {
  const process: Bo = { $type: 'bpmn:Process', flowElements: [] }
  const el = (id: string, type: string, props: Partial<Bo> = {}): Item => {
    const bo: Bo = { $type: type, $parent: process, ...props }
    process.flowElements!.push(bo)
    return { id, type, businessObject: bo, outgoing: [] }
  }
  const flow = (id: string, from: Item, to: Item, props: Partial<Bo> = {}) => {
    const f = { ...el(id, 'bpmn:SequenceFlow', props), source: from, target: to }
    from.outgoing.push(f)
    return f
  }
  return { process, el, flow }
}
/** a `qw:Config` holding `settings` */
const config = (settings: object): Partial<Bo> => ({
  extensionElements: {
    $type: 'bpmn:ExtensionElements',
    values: [{ $type: 'qw:Config', body: JSON.stringify(settings) }],
  },
})
/** a `qw-rule` condition */
const cond = (when: unknown, language = 'qw-rule'): Partial<Bo> => ({
  conditionExpression: { $type: 'bpmn:FormalExpression', language, body: JSON.stringify(when) },
})

/** start → review → exclusive fork (big: amount > 1000, other: the default) → join → end */
function leave() {
  const { process, el, flow } = diagram()
  const start = el('begin', 'bpmn:StartEvent', {
    name: 'Start',
    ...config({ access: { note: 'edit' } }),
  })
  const review = el('boss', 'bpmn:UserTask', { name: 'Boss', ...config(REVIEW) })
  const fork = el('fork', 'bpmn:ExclusiveGateway')
  const join = el('join', 'bpmn:ExclusiveGateway')
  const end = el('end', 'bpmn:EndEvent')
  const copy = el('hr', 'bpmn:SendTask', {
    name: 'HR',
    ...config({ assignee: { kind: 'initiator' } }),
  })
  const toReview = flow('f1', start, review)
  flow('f2', review, fork)
  const big = flow('big', fork, copy, { name: 'Big', ...cond(BIG) })
  const other = flow('other', fork, join)
  flow('f3', copy, join)
  flow('f4', join, end)
  fork.businessObject.default = other.businessObject
  return { process, start, review, fork, join, end, copy, toReview, big, other }
}

describe('element-node: element ↔ Target', () => {
  it('a start, review and carbon copy: their node with the qw:Config settings; written = those settings', () => {
    const d = leave()
    expect(editOf(d.review)).toEqual({
      node: { ...REVIEW, id: 'boss', type: 'review', name: 'Boss' },
    })
    expect(written(editOf(d.review))).toEqual({ name: 'Boss', config: REVIEW })
    expect(editOf(d.start)).toEqual({
      node: { id: 'begin', type: 'begin', name: 'Start', access: { note: 'edit' } },
    })
    expect(written(editOf(d.copy))).toEqual({
      name: 'HR',
      config: { assignee: { kind: 'initiator' } },
    })

    // no qw:Config, no name: a bare node, nothing to write
    const { el } = diagram()
    const start = el('s', 'bpmn:StartEvent')
    expect(editOf(start)).toEqual({ node: { id: 's', type: 'begin', name: '' } })
    expect(written(editOf(start))).toEqual({ config: {} })
    // a review without qw:Config (another tool's file) reads with a new review's settings
    expect(editOf(el('t', 'bpmn:UserTask'))).toEqual({
      node: { ...REVIEW, assignee: { kind: 'users', ids: [] }, id: 't', type: 'review', name: '' },
    })
    expect(editOf(el('c', 'bpmn:SendTask', config({ assignee: { kind: 'initiator' } })))).toEqual({
      node: { assignee: { kind: 'initiator' }, id: 'c', type: 'notify', name: '' },
    })
    // config keys that are no settings never go back (a hidden subtree, rule ⑪)
    const bad = el('r', 'bpmn:UserTask', config({ ...REVIEW, next: { id: 'x' }, name: 'X' }))
    expect(written(editOf(bad))).toEqual({ config: REVIEW })
  })

  it('a branching gateway: its fork, paths in flowElements order, the default one marked', () => {
    const d = leave()
    const fork = { id: 'fork', type: 'fork', name: '', mode: 'exclusive' }
    const big = { id: 'big', name: 'Big', when: BIG }
    const other = { id: 'other', name: '', when: [], fallback: true }
    expect(editOf(d.fork)).toEqual({ node: { ...fork, paths: [big, other] } })
    // the path order is the document order, not the order the flows were drawn in
    const all = d.process.flowElements!
    const [i, j] = [all.indexOf(d.big.businessObject), all.indexOf(d.other.businessObject)]
    ;[all[i], all[j]] = [all[j]!, all[i]!]
    expect(editOf(d.fork)).toEqual({ node: { ...fork, paths: [other, big] } })
    // a path is named after its flow, else its target, else the flow id
    expect(branchesOf(d.fork)).toEqual([
      { id: 'other', label: 'other', fallback: true },
      { id: 'big', label: 'Big', fallback: false },
    ])
    d.big.businessObject.name = undefined
    expect(branchesOf(d.fork).map((b) => b.label)).toEqual(['other', 'HR'])
    // a flow out of it: that path of the fork
    expect(editOf(d.other)).toEqual({
      fork: { ...fork, paths: [other, { ...big, name: '' }] },
      path: other,
    })
  })

  it('a path: its condition and default mark written; none, or unreadable, is no condition', () => {
    const d = leave()
    expect(written(editOf(d.big))).toEqual({ name: 'Big', when: BIG, fallback: false })
    expect(written(editOf(d.other))).toEqual({ fallback: true })
    const { el, flow } = diagram()
    const fork = el('g', 'bpmn:InclusiveGateway')
    const a = flow('a', fork, el('x', 'bpmn:EndEvent'), cond('not json', 'javascript'))
    const b = flow('b', fork, el('y', 'bpmn:EndEvent'), {
      conditionExpression: { $type: 'bpmn:FormalExpression', language: 'qw-rule', body: '{' },
    })
    expect(editOf(a)).toMatchObject({ fork: { mode: 'inclusive' }, path: { id: 'a', when: [] } })
    expect(written(editOf(b))).toEqual({ fallback: false })
  })

  it('anything else: just its name', () => {
    const d = leave()
    expect(editOf(d.end)).toEqual({ name: '' })
    expect(editOf(d.join)).toEqual({ name: '' })
    d.toReview.businessObject.name = 'go'
    expect(editOf(d.toReview)).toEqual({ name: 'go' })
    expect(written(editOf(d.toReview))).toEqual({ name: 'go' })
    expect(written({ name: '' })).toEqual({})
  })

  it('round trip: an edit written as the element holds it reads back as the same edit', () => {
    const d = leave()
    const edit = editOf(d.review) as { node: WfReviewNode }
    edit.node.name = 'Chief'
    edit.node.sign = 'all'
    edit.node.timeout = { hours: 8, action: 'autoReject' }
    const w = written(edit)
    const { el } = diagram()
    const again = el('boss', 'bpmn:UserTask', { name: w.name, ...config(w.config!) })
    expect(editOf(again)).toEqual(edit)

    const path = editOf(d.big) as Target & { path: WfForkPath }
    path.path.when = [[{ field: 'note', op: 'eq', value: 'x' }]]
    const p = written(path)
    const { el: el2, flow } = diagram()
    const fork = el2('fork', 'bpmn:ExclusiveGateway')
    const flowBack = flow('big', fork, el2('end', 'bpmn:EndEvent'), {
      name: p.name,
      ...cond(p.when),
    })
    flow('other', fork, el2('end2', 'bpmn:EndEvent'))
    expect(written(editOf(flowBack))).toEqual(p)
  })
})

describe('WfBpmnPanel', () => {
  const mounted: VueWrapper[] = []
  beforeEach(() => {
    setLocale('en-US')
    accessToken.value = 'at'
    mockApi({
      'GET /iam/users/options': ok([
        { id: 7, username: 'ann', displayName: 'Ann Lee', deptName: null },
      ]),
      'GET /iam/depts/tree': ok([]),
      'GET /iam/roles/options': ok([]),
      'GET /iam/positions/options': ok([]),
    })
    // the debounce only: Element Plus and flushPromises keep their real timers
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => {
    mounted.splice(0).forEach((w) => w.unmount())
    vi.useRealTimers()
    document.body.innerHTML = ''
    setLocale('zh-CN')
  })

  async function mountPanel(element: Item | undefined) {
    const w = mount(WfBpmnPanel, {
      props: { element, fields: FIELDS, version: 0 },
      global: { plugins: [ElementPlus, i18n] },
      attachTo: document.body,
    })
    mounted.push(w)
    await flushPromises()
    return w
  }
  /** what the panel handed on to write */
  const updates = (w: VueWrapper) => (w.emitted('update') ?? []).map(([, edit]) => edit as Written)
  /** the debounce over */
  async function settle() {
    await flushPromises()
    vi.advanceTimersByTime(300)
    await flushPromises()
  }
  const title = (w: VueWrapper) => w.find('.wf-bpmn-panel__title').text()
  const nameInput = (w: VueWrapper) => w.find<HTMLInputElement>('input[name="name"]')
  const button = (w: VueWrapper, label: string) =>
    w.findAll('button').find((b) => b.text() === label)

  it('a review: an overdue action goes into its qw:Config, "remind only" drops the key; a burst = one update', async () => {
    const d = leave()
    const w = await mountPanel(d.review)
    expect(title(w)).toBe('Approver settings')
    expect(nameInput(w).element.value).toBe('Boss')

    await w
      .findAll('.el-switch')
      .find((s) => s.text() === 'Overdue reminder')!
      .trigger('click')
    const pick = async (label: string) => {
      await w
        .find('[role="radiogroup"][aria-label="When overdue"]')
        .findAll('.el-radio')
        .find((r) => r.text() === label)!
        .find('input')
        .setValue(true)
      await flushPromises()
    }
    await pick('Approve automatically')
    expect(updates(w)).toEqual([])
    await settle()
    const due = { ...REVIEW, timeout: { hours: 24, action: 'autoPass' } }
    expect(updates(w)).toEqual([{ name: 'Boss', config: due }])

    // written (the designer bumps the version): nothing read again, nothing handed on twice
    Object.assign(d.review.businessObject, config(due))
    await w.setProps({ version: 1 })
    await pick('Remind only')
    await settle()
    expect(updates(w)).toHaveLength(2)
    expect(updates(w)[1]).toEqual({ name: 'Boss', config: { ...REVIEW, timeout: { hours: 24 } } })
    expect('action' in (updates(w)[1]!.config!.timeout as object)).toBe(false)
  })

  it('reads the element again after an outside change (undo); another selection hands a pending edit on at once', async () => {
    const d = leave()
    const w = await mountPanel(d.review)
    await nameInput(w).setValue('Chief')
    d.review.businessObject.name = 'Undone'
    await w.setProps({ version: 1 })
    expect(nameInput(w).element.value).toBe('Undone')
    await settle()
    expect(updates(w)).toEqual([])

    await nameInput(w).setValue('Chief')
    await w.setProps({ element: d.end })
    expect(w.emitted('update')).toEqual([[d.review, { name: 'Chief', config: REVIEW }]])
    expect(title(w)).toBe('End event')
    await nameInput(w).setValue('Done')
    await settle()
    expect(w.emitted('update')![1]).toEqual([d.end, { name: 'Done' }])

    await w.setProps({ element: undefined })
    expect(w.text()).toBe('Select an element on the canvas to set it up here.')
  })

  it('a path: its condition written; "make default" marks it, its condition gone; not for the default or a parallel path', async () => {
    const d = leave()
    const w = await mountPanel(d.big)
    expect(title(w)).toBe('Path settings')
    await button(w, 'Add a condition group')!.trigger('click')
    await settle()
    expect(updates(w)).toEqual([
      { name: 'Big', when: [...BIG, [{ field: 'amount', op: 'eq', value: '' }]], fallback: false },
    ])

    await button(w, 'Make default path')!.trigger('click')
    expect(updates(w)[1]).toEqual({ name: 'Big', fallback: true })

    await w.setProps({ element: d.other })
    expect(button(w, 'Make default path')).toBeUndefined()
    expect(w.text()).toContain('Taken when the conditions of no other path match.')
    const { el, flow } = diagram()
    const fork = el('p', 'bpmn:ParallelGateway')
    const both = flow('a', fork, el('x', 'bpmn:EndEvent'))
    flow('b', fork, el('y', 'bpmn:EndEvent'))
    await w.setProps({ element: both })
    expect(button(w, 'Make default path')).toBeUndefined()
    expect(w.text()).toContain('Runs alongside the other paths.')
  })

  it('a fork: its paths in order, the default marked; up / down reorder them, "add a path" adds one', async () => {
    const d = leave()
    const w = await mountPanel(d.fork)
    expect(title(w)).toBe('Branching gateway settings')
    expect(w.text()).toContain('An exclusive branch takes the first path in this order')
    const rows = () =>
      w.findAll('.wf-bpmn-panel__path').map((r) => ({
        no: r.find('.wf-bpmn-panel__no').text(),
        name: r.find('.wf-bpmn-panel__name').text(),
        fallback: r.find('.el-tag').exists(),
        moves: r.findAll('button').map((b) => b.attributes('aria-label')),
      }))
    expect(rows()).toEqual([
      { no: '1', name: 'Big', fallback: false, moves: ['Move down'] },
      { no: '2', name: 'other', fallback: true, moves: ['Move up'] },
    ])
    await w.findAll('.wf-bpmn-panel__path')[0]!.find('button').trigger('click')
    expect(w.emitted('reorder')).toEqual([['big', 'other']])
    // swapped by the designer: the list follows the next version
    const all = d.process.flowElements!
    const [i, j] = [all.indexOf(d.big.businessObject), all.indexOf(d.other.businessObject)]
    ;[all[i], all[j]] = [all[j]!, all[i]!]
    await w.setProps({ version: 1 })
    expect(rows().map((r) => r.name)).toEqual(['other', 'Big'])

    await button(w, 'Add a path')!.trigger('click')
    expect(w.emitted('addPath')).toEqual([['fork']])
    expect(updates(w)).toEqual([])
  })
})
