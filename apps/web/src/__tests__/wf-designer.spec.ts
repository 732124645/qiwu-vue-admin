// WfDesigner edit mode (see docs/design-notes.md#workflow): cards and "+" per chain, add / delete / copy nodes,
// fork paths (add, move, delete) and the fork mode switch, edited in place on the draft tree. Read-only mode
// an instance's progress on the cards, nothing to edit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElDrawer, ElDropdown, ElMessageBox } from 'element-plus'
import {
  compile,
  type WfBeginNode,
  type WfFields,
  type WfForkNode,
  type WfNodeProgress,
  type WfReviewNode,
  type WfStep,
} from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import WfDesigner from '@/views/workflow/designer/WfDesigner.vue'
import { idsOf, newStep } from '@/views/workflow/designer/tree'
import { mockApi, ok } from './mock-api'

const FIELDS: WfFields = { amount: 'number', reason: 'string', applicant: 'user' }
const review = (id: string, next?: WfStep): WfReviewNode => ({
  id,
  type: 'review',
  name: `Review ${id}`,
  assignee: { kind: 'users', ids: [7] },
  sign: 'any',
  whenNobody: 'toManager',
  whenInitiatorIsReviewer: 'self',
  onReject: 'finish',
  ...(next && { next }),
})
/** begin → r1 → f1 (p1: amount > 1000 → r2 | p2: fallback) → n1 */
const tree = (): WfBeginNode => ({
  id: 'begin',
  type: 'begin',
  name: 'Start',
  next: review('r1', {
    id: 'f1',
    type: 'fork',
    name: 'Fork',
    mode: 'exclusive',
    paths: [
      {
        id: 'p1',
        name: 'Big',
        when: [
          [{ field: 'amount', op: 'gt', value: 1000 }],
          [
            { field: '$initiator.dept', op: 'inDeptTree', value: [4, 5] },
            { field: 'applicant', op: 'eq', value: 9 },
          ],
        ],
        child: review('r2'),
      },
      { id: 'p2', name: 'Else', fallback: true, when: [] },
    ],
    next: { id: 'n1', type: 'notify', name: 'CC', assignee: { kind: 'initiator' } },
  }),
})

let confirm: ReturnType<typeof vi.spyOn>
const mounted: VueWrapper[] = []
beforeEach(() => {
  setLocale('en-US')
  accessToken.value = 'at'
  confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
})
afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount())
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

function mountDesigner(t = tree()) {
  const model = reactive(t) as WfBeginNode
  const w = mount(WfDesigner, {
    props: { modelValue: model, fields: FIELDS },
    global: { plugins: [ElementPlus, i18n] },
    attachTo: document.body,
  })
  mounted.push(w)
  return { w, t: model }
}
const order = (w: VueWrapper) =>
  w.findAll('[data-node-id]').map((e) => e.attributes('data-node-id'))
const card = (w: VueWrapper, id: string) => w.find(`[data-node-id="${id}"]`)
const body = (w: VueWrapper, id: string) => card(w, id).find('.wf-card__body')
const button = (w: VueWrapper, id: string, label: string) =>
  card(w, id).find(`${id.startsWith('f') ? '.wf-fork__head ' : ''}button[aria-label="${label}"]`)
/** the "+" menus in page order: [0] below begin, then one below each step of a chain, depth first */
const adders = (w: VueWrapper) => w.findAllComponents(ElDropdown)
const fork = (t: WfBeginNode) => t.next!.next as WfForkNode
/** node and path ids counted one by one (a duplicate id counts twice, unlike idsOf) */
function count(n: WfStep | WfBeginNode | undefined): number {
  let c = 0
  for (; n; n = n.next) {
    c++
    if (n.type === 'fork') for (const p of n.paths) c += 1 + count(p.child)
  }
  return c
}

describe('WfDesigner', () => {
  it('draws the tree as cards in order, with summaries, and the end', async () => {
    const { w } = mountDesigner()
    expect(order(w)).toEqual(['begin', 'r1', 'f1', 'p1', 'r2', 'p2', 'n1'])
    expect(body(w, 'begin').text()).toBe('The initiator submits the request')
    expect(body(w, 'r1').text()).toBe('Specific users · 1 item')
    expect(body(w, 'p1').text()).toBe(
      "amount is greater than 1000 or Initiator's department is under 2 items and applicant equals #9",
    )
    expect(body(w, 'p2').text()).toBe('When no other path matches')
    expect(body(w, 'n1').text()).toBe('The initiator')
    expect(w.find('.wf-designer__end').text()).toBe('End')
    // a "+" below begin, below every step and at the head of each path
    expect(adders(w)).toHaveLength(7)
    await adders(w)[0]!.find('button').trigger('click')
    await flushPromises()
    expect(
      new DOMWrapper(document.body)
        .findAll('.el-dropdown-menu__item')
        .slice(0, 3)
        .map((i) => i.text()),
    ).toEqual(['Approver', 'CC', 'Branch'])
  })

  it('"+" puts a new node right below, the rest follows it; new nodes need their assignees picked', async () => {
    const { w, t } = mountDesigner()
    const f1 = fork(t)
    adders(w)[0]!.vm.$emit('command', 'review')
    await flushPromises()
    const added = t.next as WfReviewNode
    expect(added).toMatchObject({
      type: 'review',
      name: 'Approver',
      assignee: { kind: 'users', ids: [] },
      sign: 'any',
      // never a silent auto-pass by default
      whenNobody: 'toManager',
      whenInitiatorIsReviewer: 'self',
      onReject: 'finish',
    })
    expect(added.next?.id).toBe('r1')
    expect(order(w).slice(0, 3)).toEqual(['begin', added.id, 'r1'])
    expect(body(w, added.id).text()).toBe('Set up: Specific users')
    expect(body(w, added.id).classes()).toContain('is-missing')

    // at the head of the empty fallback path: a fork with a conditional path and a fallback
    const p2 = adders(w).findIndex((a) => a.element.closest('.wf-fork__path:last-child'))
    adders(w)[p2]!.vm.$emit('command', 'fork')
    await flushPromises()
    const inner = f1.paths[1]!.child as WfForkNode
    expect(inner).toMatchObject({ type: 'fork', name: 'Branch', mode: 'exclusive' })
    expect(inner.paths.map((p) => [p.name, !!p.fallback, p.when])).toEqual([
      ['Path 1', false, []],
      ['Otherwise', true, []],
    ])
    expect(body(w, inner.paths[0]!.id).text()).toBe('Set up the conditions')
    // below the notify at the end
    adders(w).at(-1)!.vm.$emit('command', 'notify')
    await flushPromises()
    expect(f1.next!.next).toMatchObject({ type: 'notify', name: 'CC' })
    expect(idsOf(t).size).toBe(count(t))
  })

  it('delete drops the node and lifts what follows; a fork with nodes on its paths asks first', async () => {
    const { w, t } = mountDesigner()
    await button(w, 'r1', 'Delete').trigger('click')
    await flushPromises()
    expect(t.next?.id).toBe('f1')
    expect(confirm).not.toHaveBeenCalled()

    confirm.mockRejectedValueOnce('cancel')
    await button(w, 'f1', 'Delete').trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledOnce()
    expect(t.next?.id).toBe('f1')
    await button(w, 'f1', 'Delete').trigger('click')
    await flushPromises()
    expect(t.next?.id).toBe('n1')
    expect(order(w)).toEqual(['begin', 'n1'])
  })

  it('copy puts a copy with new ids right after the node: a fork with its paths and their nodes', async () => {
    const { w, t } = mountDesigner()
    await button(w, 'f1', 'Copy').trigger('click')
    await flushPromises()
    const [original, copy] = [fork(t), fork(t).next as WfForkNode]
    expect(copy.type).toBe('fork')
    expect(copy.next?.id).toBe('n1')
    expect(original.next).toBe(copy)
    const strip = (f: WfForkNode) =>
      JSON.parse(JSON.stringify(f, (k, v) => (k === 'id' || k === 'next' ? undefined : v)))
    expect(strip(copy)).toEqual(strip(original))
    expect(copy.id).not.toBe('f1')
    expect(copy.paths.map((p) => p.id)).not.toContain('p1')
    expect(copy.paths[0]!.child!.id).not.toBe('r2')
    // one namespace, no id twice
    expect(idsOf(t).size).toBe(count(t))
    expect(compile(t, FIELDS).ok).toBe(true)

    // the last node: the copy ends the process
    await button(w, 'n1', 'Copy').trigger('click')
    const n1 = copy.next!
    expect(n1.next).toMatchObject({ type: 'notify', name: 'CC', assignee: { kind: 'initiator' } })
    expect(n1.next!.id).not.toBe('n1')
    expect(n1.next!.next).toBeUndefined()
  })

  it('paths: new ones go before the fallback, move among the conditional ones, delete down to two', async () => {
    const { w, t } = mountDesigner()
    const f = fork(t)
    const labels = (id: string) =>
      card(w, id)
        .findAll('.wf-card__actions button')
        .map((b) => b.attributes('aria-label'))
    expect(labels('p1')).toEqual([])
    expect(labels('p2')).toEqual([])

    await button(w, 'f1', 'Add a path').trigger('click')
    const added = f.paths[1]!
    expect(f.paths.map((p) => p.id)).toEqual(['p1', added.id, 'p2'])
    expect(added).toMatchObject({ name: 'Path 2', when: [] })
    expect(added.fallback).toBeUndefined()
    // the fallback stays last and stays
    expect(labels('p1')).toEqual(['Move right', 'Delete the path'])
    expect(labels(added.id)).toEqual(['Move left', 'Delete the path'])
    expect(labels('p2')).toEqual([])

    await card(w, added.id).find('button[aria-label="Move left"]').trigger('click')
    expect(f.paths.map((p) => p.id)).toEqual([added.id, 'p1', 'p2'])
    expect(order(w).slice(3, 7)).toEqual([added.id, 'p1', 'r2', 'p2'])

    // a path with nodes asks first
    confirm.mockRejectedValueOnce('cancel')
    await card(w, 'p1').find('button[aria-label="Delete the path"]').trigger('click')
    await flushPromises()
    expect(f.paths).toHaveLength(3)
    await card(w, added.id).find('button[aria-label="Delete the path"]').trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledOnce()
    expect(f.paths.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(labels('p1')).toEqual([])
  })

  it('mode switch: inclusive keeps the paths, parallel drops conditions and the fallback after asking', async () => {
    const { w, t } = mountDesigner()
    const f = fork(t)
    const mode = (label: string) =>
      card(w, 'f1')
        .findAll('.wf-fork__head .el-radio-button')
        .find((r) => r.text() === label)!
        .find('input')
    expect(
      card(w, 'f1')
        .findAll('.wf-fork__head .el-radio-button')
        .map((r) => [r.text(), r.classes('is-active')]),
    ).toEqual([
      ['Exclusive', true],
      ['Inclusive', false],
      ['Parallel', false],
    ])

    await mode('Inclusive').setValue(true)
    await flushPromises()
    expect(f.mode).toBe('inclusive')
    expect(f.paths[0]!.when).toHaveLength(2)
    expect(confirm).not.toHaveBeenCalled()

    confirm.mockRejectedValueOnce('cancel')
    await mode('Parallel').setValue(true)
    await flushPromises()
    expect(f.mode).toBe('inclusive')
    expect(f.paths[0]!.when).toHaveLength(2)

    await mode('Parallel').setValue(true)
    await flushPromises()
    expect(f.mode).toBe('parallel')
    expect(f.paths.map((p) => [p.when, p.fallback])).toEqual([
      [[], undefined],
      [[], undefined],
    ])
    expect(body(w, 'p1').text()).toBe('Runs alongside the other paths.')
    expect(body(w, 'p2').text()).toBe('Runs alongside the other paths.')
    expect(compile(t, FIELDS).ok).toBe(true)
    // parallel paths all move; a new one goes last
    await button(w, 'f1', 'Add a path').trigger('click')
    expect(f.paths.map((p) => p.name)).toEqual(['Big', 'Else', 'Path 3'])
    expect(card(w, 'p2').findAll('.wf-card__actions button')).toHaveLength(3)

    // back to exclusive: the last path becomes the fallback, the others need conditions again
    await mode('Exclusive').setValue(true)
    await flushPromises()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(f.mode).toBe('exclusive')
    expect(f.paths.map((p) => !!p.fallback)).toEqual([false, false, true])
    expect(body(w, 'p1').text()).toBe('Set up the conditions')
    const errors = compile(t, FIELDS)
    expect(!errors.ok && errors.errors.map((e) => [e.code, e.id])).toEqual([
      ['path_when_required', 'p1'],
      ['path_when_required', 'p2'],
    ])
  })

  it('default path names follow the mode; a new path never repeats a default name', async () => {
    const { w, t } = mountDesigner()
    adders(w).at(-1)!.vm.$emit('command', 'fork')
    await flushPromises()
    const f = t.next!.next!.next!.next as WfForkNode
    const names = () => f.paths.map((p) => p.name)
    const mode = (label: string) =>
      card(w, f.id)
        .findAll('.wf-fork__head .el-radio-button')
        .find((r) => r.text() === label)!
        .find('input')
    expect(names()).toEqual(['Path 1', 'Otherwise'])
    await mode('Parallel').setValue(true)
    await flushPromises()
    expect(names()).toEqual(['Path 1', 'Path 2'])
    await mode('Exclusive').setValue(true)
    await flushPromises()
    expect(names()).toEqual(['Path 1', 'Otherwise'])
    // an admin's own names stay
    f.paths[1]!.name = 'Rest'
    await mode('Parallel').setValue(true)
    await flushPromises()
    f.paths[0]!.name = 'Mine'
    await mode('Inclusive').setValue(true)
    await flushPromises()
    expect(names()).toEqual(['Mine', 'Rest'])
    expect(f.paths.map((p) => !!p.fallback)).toEqual([false, true])
    // numbered after the default names in use
    f.paths[0]!.name = 'Path 1'
    await button(w, f.id, 'Add a path').trigger('click')
    await button(w, f.id, 'Add a path').trigger('click')
    expect(names()).toEqual(['Path 1', 'Path 2', 'Path 3', 'Rest'])
    f.paths.splice(1, 1)
    await button(w, f.id, 'Add a path').trigger('click')
    expect(names()).toEqual(['Path 1', 'Path 3', 'Path 4', 'Rest'])
  })

  it('seeded names (see docs/design-notes.md#i18n) read translated on the cards', () => {
    const t = tree()
    t.name = 'seed.dept.hq'
    t.next!.name = 'seed.dept.hq'
    fork(t).paths[0]!.name = 'seed.dept.hq'
    const { w } = mountDesigner(t)
    const shown = i18n.global.t('seed.dept.hq')
    expect(shown).not.toBe('seed.dept.hq')
    expect(['begin', 'r1', 'p1'].map((id) => card(w, id).find('.wf-card__name').text())).toEqual([
      shown,
      shown,
      shown,
    ])
  })

  it('a condition without its value marks the path (compile rejects it)', async () => {
    const { w, t } = mountDesigner()
    fork(t).paths[0]!.when = [[{ field: 'reason', op: 'eq', value: '' }]]
    await flushPromises()
    expect(body(w, 'p1').text()).toBe('reason equals ?')
    expect(body(w, 'p1').classes()).toContain('is-missing')
    const errors = compile(t, FIELDS)
    expect(!errors.ok && errors.errors.map((e) => [e.code, e.id])).toEqual([
      ['value_mismatch', 'p1'],
    ])
    fork(t).paths[0]!.when = [[{ field: 'amount', op: 'in', value: [] }]]
    await flushPromises()
    expect(body(w, 'p1').classes()).toContain('is-missing')
    fork(t).paths[0]!.when = [[{ field: 'reason', op: 'eq', value: 'x' }]]
    await flushPromises()
    expect(body(w, 'p1').classes()).not.toContain('is-missing')
  })

  it('a card opens its settings in the drawer and is marked while open', async () => {
    mockApi({ 'GET /iam/users/options': ok([]) })
    const { w } = mountDesigner()
    await card(w, 'r1').find('.wf-card__main').trigger('click')
    await flushPromises()
    const drawer = () => new DOMWrapper(document.body).find('.wf-node-drawer')
    expect(drawer().find('.el-drawer__title').text()).toBe('Approver settings')
    expect(card(w, 'r1').classes()).toContain('is-active')
    // closed (el-drawer reports it once its leave transition ends)
    w.findComponent(ElDrawer).vm.$emit('update:modelValue', false)
    await flushPromises()
    expect(card(w, 'r1').classes()).not.toContain('is-active')
    expect(w.findComponent(ElDrawer).exists()).toBe(false)

    await card(w, 'p1').find('.wf-card__main').trigger('click')
    await flushPromises()
    expect(drawer().find('.el-drawer__title').text()).toBe('Path settings')
    expect(card(w, 'p1').classes()).toContain('is-active')
    // a path drawer sets up the path, conditions or not (both languages alike)
    setLocale('zh-CN')
    await flushPromises()
    expect(drawer().find('.el-drawer__title').text()).toBe('分支设置')
  })

  it('a head chain without levels reads up to the top (as the engine runs it)', () => {
    const chain = (id: string, levels?: number, next?: WfStep): WfReviewNode => ({
      ...review(id, next),
      assignee: { kind: 'deptHeadChain', ...(levels && { levels }) },
    })
    const { w } = mountDesigner({
      id: 'begin',
      type: 'begin',
      name: 'Start',
      next: chain('r1', undefined, chain('r2', 2)),
    })
    expect(body(w, 'r1').text()).toBe('Chain of department heads · up to the top')
    expect(body(w, 'r2').text()).toBe('Chain of department heads · 2 levels')
  })

  it('newStep ids never repeat one in use', () => {
    const taken = new Set<string>()
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('aaaaaaaa-0000-4000-8000-000000000000')
      .mockReturnValueOnce('aaaaaaaa-1111-4000-8000-000000000000')
      .mockReturnValueOnce('bbbbbbbb-0000-4000-8000-000000000000')
    expect(newStep('review', taken).id).toBe('review_aaaaaaaa')
    expect(newStep('review', taken).id).toBe('review_bbbbbbbb')
  })
})

// The designer runs the shared `compile` (the server's publish check), lists the errors and locates them.
describe('WfDesigner validate()', () => {
  let scroll: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
  })
  const errorList = (w: VueWrapper) => w.findAll('.wf-designer__errors li').map((li) => li.text())
  const marked = (w: VueWrapper) =>
    w.findAll('[data-node-id].is-error').map((e) => e.attributes('data-node-id'))
  /** r1 without reviewers, p1 without conditions */
  function broken() {
    const t = tree()
    ;(t.next as WfReviewNode).assignee.ids = []
    fork(t).paths[0]!.when = []
    return t
  }

  it('a publishable tree passes; nothing is listed or marked', async () => {
    const { w } = mountDesigner()
    expect(w.vm.validate()).toBe(true)
    await flushPromises()
    expect(w.find('.wf-designer__errors').exists()).toBe(false)
    expect(marked(w)).toEqual([])
    expect(scroll).not.toHaveBeenCalled()
  })

  it('errors block publishing: listed by node name, cards marked, the first scrolled to', async () => {
    const { w } = mountDesigner(broken())
    // nothing shown before the first check
    expect(w.find('.wf-designer__errors').exists()).toBe(false)
    expect(marked(w)).toEqual([])
    expect(w.vm.validate()).toBe(false)
    await flushPromises()
    expect(w.find('.wf-designer__errors-title').text()).toBe('2 problems to fix before publishing')
    expect(errorList(w)).toEqual([
      'Select the approvers for step "Review r1"',
      'Path "Big" needs a condition',
    ])
    expect(marked(w)).toEqual(['r1', 'p1'])
    expect(scroll).toHaveBeenCalledOnce()
    expect(scroll.mock.contexts[0]).toBe(card(w, 'r1').element)
    // validate() only scrolls: no drawer
    expect(w.findComponent(ElDrawer).exists()).toBe(false)

    setLocale('zh-CN')
    await flushPromises()
    expect(errorList(w)[0]).toBe('请选择节点 “Review r1” 的审批人')
  })

  it('an error in the list scrolls to its card and opens it', async () => {
    mockApi({ 'GET /iam/users/options': ok([]) })
    const { w } = mountDesigner(broken())
    w.vm.validate()
    await flushPromises()
    await w.findAll('.wf-designer__error')[1]!.trigger('click')
    await flushPromises()
    expect(scroll.mock.contexts.at(-1)).toBe(card(w, 'p1').element)
    expect(new DOMWrapper(document.body).find('.wf-node-drawer .el-drawer__title').text()).toBe(
      'Path settings',
    )
    expect(card(w, 'p1').classes()).toEqual(expect.arrayContaining(['is-active', 'is-error']))
  })

  it('the list follows edits once checked; fixed, the tree passes', async () => {
    const { w, t } = mountDesigner(broken())
    w.vm.validate()
    ;(t.next as WfReviewNode).assignee.ids = [7]
    await flushPromises()
    expect(errorList(w)).toEqual(['Path "Big" needs a condition'])
    expect(marked(w)).toEqual(['p1'])
    fork(t).paths[0]!.when = [[{ field: 'amount', op: 'gt', value: 1 }]]
    await flushPromises()
    expect(w.find('.wf-designer__errors').exists()).toBe(false)
    expect(marked(w)).toEqual([])
    expect(w.vm.validate()).toBe(true)
  })

  it('a fork error marks and scrolls to the fork head; a fork has no drawer', async () => {
    const t = tree()
    // no fallback path left
    Object.assign(fork(t).paths[1]!, {
      fallback: false,
      when: [[{ field: 'reason', op: 'eq', value: 'x' }]],
    })
    const { w } = mountDesigner(t)
    expect(w.vm.validate()).toBe(false)
    await flushPromises()
    expect(errorList(w)).toEqual(['Branch "Fork" needs exactly one default path'])
    expect(marked(w)).toEqual(['f1'])
    const head = card(w, 'f1').find('.wf-fork__head').element
    expect(scroll.mock.contexts[0]).toBe(head)
    await w.find('.wf-designer__error').trigger('click')
    await flushPromises()
    expect(scroll.mock.contexts[1]).toBe(head)
    expect(w.findComponent(ElDrawer).exists()).toBe(false)
  })

  it('shape errors name the node (its type when unnamed) and the setting', async () => {
    const t = tree()
    t.next!.name = '  '
    fork(t).paths[0]!.name = ''
    // a draft is any tree-shaped object: a name may be missing
    delete (fork(t).next as Partial<WfStep>).name
    const { w } = mountDesigner(t)
    expect(w.vm.validate()).toBe(false)
    await flushPromises()
    expect(errorList(w)).toEqual([
      '"Approver": Name is required',
      '"Path 1": Name is required',
      '"CC": Name is required',
    ])
    expect(marked(w)).toEqual(['r1', 'p1', 'n1'])
  })
})

describe('WfDesigner read-only (progress)', () => {
  const PROGRESS: Record<string, WfNodeProgress> = {
    begin: 'done',
    r1: 'done',
    f1: 'active',
    p1: 'done',
    r2: 'active',
    p2: 'skipped',
    n1: 'pending',
  }

  it('each card and the fork head carry their progress, named; a legend of those shown', () => {
    const t = tree()
    const w = mount(WfDesigner, {
      props: { modelValue: t, fields: FIELDS, progress: PROGRESS },
      global: { plugins: [ElementPlus, i18n] },
    })
    mounted.push(w)
    const shown = Object.fromEntries(
      w
        .findAll('[data-node-id]')
        .map((e) => [e.attributes('data-node-id'), e.attributes('data-progress')]),
    )
    expect(shown).toEqual(PROGRESS)
    expect(card(w, 'r2').find('.wf-progress').attributes('aria-label')).toBe('In progress')
    expect(card(w, 'p2').find('.wf-progress').attributes('aria-label')).toBe('Not taken')
    expect(card(w, 'f1').find('.wf-fork__head').text()).toBe('Exclusive')
    expect(w.findAll('.wf-designer__legend li').map((l) => l.text())).toEqual([
      'Done',
      'In progress',
      'Not reached',
      'Not taken',
    ])
  })

  it('nothing edits: no "+", no card actions or mode switch, a card opens no drawer', async () => {
    const t = tree()
    const w = mount(WfDesigner, {
      props: { modelValue: t, fields: FIELDS, progress: PROGRESS },
      global: { plugins: [ElementPlus, i18n] },
    })
    mounted.push(w)
    expect(adders(w)).toHaveLength(0)
    expect(w.findAll('button')).toHaveLength(0)
    expect(w.find('.el-radio-group').exists()).toBe(false)
    await card(w, 'r1').find('.wf-card__main').trigger('click')
    await flushPromises()
    expect(w.findComponent(ElDrawer).exists()).toBe(false)
    expect(t).toEqual(tree())
  })
})
