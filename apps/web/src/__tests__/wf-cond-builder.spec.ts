// WfDesigner's node drawer, part 2 (see docs/design-notes.md#workflow): the condition builder (OR of AND groups over the
// form fields, plus the initiator's department and roles) and the field access table.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, {
  ElDatePicker,
  ElInputNumber,
  ElInputTag,
  ElMessage,
  ElSelect,
  ElTreeSelect,
} from 'element-plus'
import {
  compile,
  type DeptTreeNode,
  type WfBeginNode,
  type WfCondition,
  type WfFields,
  type WfForkNode,
  wfTree,
} from '@qiwu/shared'
import UserSelect from '@/core/components/UserSelect.vue'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import WfCondBuilder from '@/views/workflow/designer/WfCondBuilder.vue'
import WfNodeDrawer from '@/views/workflow/designer/WfNodeDrawer.vue'
import WfUserIds from '@/views/workflow/designer/WfUserIds.vue'
import { mockApi, ok } from './mock-api'

const FIELDS: WfFields = {
  amount: 'number',
  reason: 'string',
  startDate: 'date',
  applicant: 'user',
  costCenter: 'dept',
}
const DEPTS: DeptTreeNode[] = [{ id: 1, parentId: 0, name: 'seed.dept.hq', children: [] }]

let calls: ReturnType<typeof mockApi>
const mounted: VueWrapper[] = []
beforeEach(() => {
  setLocale('en-US')
  accessToken.value = 'at'
  vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
  calls = mockApi({
    'GET /iam/depts/tree': ok(DEPTS),
    'GET /iam/users/options': ok([]),
    'GET /iam/roles/options': ok([
      { id: 2, code: 'member', name: 'seed.role.member' },
      { id: 5, code: 'hr', name: 'HR' },
    ]),
  })
})
afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount())
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

function mountBuilder(when: WfCondition[][] = [], fields = FIELDS) {
  const model = reactive(when) as WfCondition[][]
  const w = mount(WfCondBuilder, {
    props: { modelValue: model, fields },
    global: { plugins: [ElementPlus, i18n] },
    attachTo: document.body,
  })
  mounted.push(w)
  return { w, when: model }
}
const button = (w: VueWrapper, text: string) => w.findAll('button').find((b) => b.text() === text)!
const rows = (w: VueWrapper) => w.findAll('.wf-cond__row')
/** field / op select of condition `i` (in page order) */
const select = (w: VueWrapper, i: number, which: 'field' | 'op') =>
  w.findAllComponents(ElSelect).filter((s) => s.classes(`wf-cond__${which}`))[i]!
/** the option labels of an el-select, group titles in brackets (its dropdown opened by a click) */
async function options(s: VueWrapper) {
  await s.find('.el-select__wrapper').trigger('click')
  await flushPromises()
  const list = new DOMWrapper(document.body).find(`#${s.find('input').attributes('aria-controls')}`)
  return list
    .findAll('.el-select-group__title, .el-select-dropdown__item')
    .map((o) => (o.classes('el-select-group__title') ? `[${o.text()}]` : o.text()))
}
async function pick(w: VueWrapper, i: number, which: 'field' | 'op', value: string) {
  select(w, i, which).vm.$emit('update:modelValue', value)
  await flushPromises()
}

describe('WfCondBuilder', () => {
  it('starts empty; a group starts with the first form field, its first op and no value', async () => {
    const { w, when } = mountBuilder()
    expect(w.find('.wf-cond__hint').text()).toBe(
      'The path is taken when every condition of any one group matches.',
    )
    expect(rows(w)).toHaveLength(0)
    await button(w, 'Add a condition group').trigger('click')
    expect(when).toEqual([[{ field: 'amount', op: 'eq', value: '' }]])
    expect(w.find('.wf-cond__legend').text()).toBe('Group 1')
    expect(await options(select(w, 0, 'field'))).toEqual([
      '[Form fields]',
      'amount number',
      'reason text',
      'startDate date',
      'applicant user',
      'costCenter department',
      '[Initiator]',
      "Initiator's department",
      "Initiator's roles",
    ])
    expect(await options(select(w, 0, 'op'))).toEqual([
      'equals',
      'does not equal',
      'is greater than',
      'is at least',
      'is less than',
      'is at most',
      'is one of',
    ])
  })

  it('ops and value inputs follow the field type; a new field starts over, a new op keeps a value it takes', async () => {
    const { w, when } = mountBuilder([[{ field: 'amount', op: 'eq', value: '' }]])
    const c = () => when[0]![0]!
    w.findComponent(ElInputNumber).vm.$emit('update:modelValue', 1000)
    await flushPromises()
    await pick(w, 0, 'op', 'gt')
    expect(c()).toEqual({ field: 'amount', op: 'gt', value: 1000 })
    await pick(w, 0, 'op', 'in')
    expect(c()).toEqual({ field: 'amount', op: 'in', value: [] })
    // typed values become numbers, the rest is dropped
    w.findComponent(ElInputTag).vm.$emit('update:modelValue', ['5', 'x', '7'])
    await flushPromises()
    expect(c().value).toEqual([5, 7])

    await pick(w, 0, 'field', 'reason')
    expect(c()).toEqual({ field: 'reason', op: 'eq', value: '' })
    expect(await options(select(w, 0, 'op'))).toEqual([
      'equals',
      'does not equal',
      'is one of',
      'contains',
    ])
    await pick(w, 0, 'op', 'contains')
    await rows(w)[0]!.find('.wf-cond__value input').setValue('urgent')
    expect(c()).toEqual({ field: 'reason', op: 'contains', value: 'urgent' })
    await pick(w, 0, 'op', 'in')
    w.findComponent(ElInputTag).vm.$emit('update:modelValue', ['a', 'b'])
    await flushPromises()
    expect(c()).toEqual({ field: 'reason', op: 'in', value: ['a', 'b'] })

    await pick(w, 0, 'field', 'startDate')
    expect(await options(select(w, 0, 'op'))).toHaveLength(6)
    w.findComponent(ElDatePicker).vm.$emit('update:modelValue', '2026-10-01')
    await flushPromises()
    expect(c()).toEqual({ field: 'startDate', op: 'eq', value: '2026-10-01' })

    await pick(w, 0, 'field', 'applicant')
    expect(await options(select(w, 0, 'op'))).toEqual(['equals', 'does not equal', 'is one of'])
    w.findComponent(UserSelect).vm.$emit('update:modelValue', 8)
    await flushPromises()
    expect(c()).toEqual({ field: 'applicant', op: 'eq', value: 8 })
    await pick(w, 0, 'op', 'in')
    expect(w.findComponent(UserSelect).exists()).toBe(false)
    w.findComponent(WfUserIds).vm.$emit('update:modelValue', [8, 9])
    await flushPromises()
    expect(c()).toEqual({ field: 'applicant', op: 'in', value: [8, 9] })

    await pick(w, 0, 'field', 'costCenter')
    w.findComponent(ElTreeSelect).vm.$emit('update:modelValue', 1)
    await flushPromises()
    expect(c()).toEqual({ field: 'costCenter', op: 'eq', value: 1 })
    await pick(w, 0, 'op', 'in')
    expect(w.findComponent(ElTreeSelect).props('multiple')).toBe(true)
    w.findComponent(ElTreeSelect).vm.$emit('update:modelValue', [1])
    await flushPromises()
    expect(c()).toEqual({ field: 'costCenter', op: 'in', value: [1] })
  })

  it("the initiator's department (subtrees included) and roles take their one op each", async () => {
    const { w, when } = mountBuilder([[{ field: 'amount', op: 'gt', value: 5 }]])
    const c = () => when[0]![0]!
    await pick(w, 0, 'field', '$initiator.dept')
    expect(c()).toEqual({ field: '$initiator.dept', op: 'inDeptTree', value: [] })
    expect(await options(select(w, 0, 'op'))).toEqual(['is under'])
    const depts = w.findComponent(ElTreeSelect)
    expect(depts.props('multiple')).toBe(true)
    depts.vm.$emit('update:modelValue', [1])
    await flushPromises()
    expect(c().value).toEqual([1])

    expect(calls.filter((x) => x.url === '/iam/roles/options')).toHaveLength(0)
    await pick(w, 0, 'field', '$initiator.roles')
    expect(c()).toEqual({ field: '$initiator.roles', op: 'hasRole', value: [] })
    expect(await options(select(w, 0, 'op'))).toEqual(['has any of'])
    const roles = w.findAllComponents(ElSelect).find((s) => s.props('multiple'))!
    expect(await options(roles)).toEqual(['Registered member', 'HR'])
    roles.vm.$emit('update:modelValue', [2, 5])
    await flushPromises()
    expect(c()).toEqual({ field: '$initiator.roles', op: 'hasRole', value: [2, 5] })
    expect(calls.filter((x) => x.url === '/iam/roles/options')).toHaveLength(1)
  })

  it('OR of AND groups; the last condition of a group takes the group with it', async () => {
    const { w, when } = mountBuilder()
    await button(w, 'Add a condition group').trigger('click')
    await button(w, 'Add a condition').trigger('click')
    await button(w, 'Add a condition group').trigger('click')
    expect(when.map((g) => g.length)).toEqual([2, 1])
    expect(w.findAll('.wf-cond__and').map((e) => e.text())).toEqual(['and'])
    expect(w.findAll('.wf-cond__or').map((e) => e.text())).toEqual(['or'])
    expect(w.findAll('.wf-cond__legend').map((e) => e.text())).toEqual(['Group 1', 'Group 2'])

    await rows(w)[0]!.find('button[aria-label="Remove the condition"]').trigger('click')
    expect(when.map((g) => g.length)).toEqual([1, 1])
    await rows(w)[0]!.find('button[aria-label="Remove the condition"]').trigger('click')
    expect(when.map((g) => g.length)).toEqual([1])
    expect(w.find('.wf-cond__or').exists()).toBe(false)
  })

  it('user names still show after a condition above is removed (its user list is reused)', async () => {
    mockApi({
      'GET /iam/users/options': ok([
        { id: 7, username: 'ann', displayName: 'Ann Lee', deptName: null },
      ]),
    })
    const { w, when } = mountBuilder([
      [
        { field: 'applicant', op: 'in', value: [] },
        { field: 'applicant', op: 'in', value: [7] },
      ],
    ])
    await flushPromises()
    const tags = () => w.findAll('.wf-user-ids .el-tag').map((t) => t.text())
    expect(tags()).toEqual(['Ann Lee'])
    await rows(w)[0]!.find('button[aria-label="Remove the condition"]').trigger('click')
    await flushPromises()
    expect(when).toEqual([[{ field: 'applicant', op: 'in', value: [7] }]])
    expect(tags()).toEqual(['Ann Lee'])
  })

  it('a saved "user equals" value reads by name; the department pickers have an accessible name', async () => {
    mockApi({
      'GET /iam/depts/tree': ok(DEPTS),
      'GET /iam/users/options': ok([
        { id: 9, username: 'cat', displayName: 'Cat Ng', deptName: null },
      ]),
    })
    const { w } = mountBuilder([
      [
        { field: 'applicant', op: 'eq', value: 9 },
        { field: 'costCenter', op: 'eq', value: 1 },
        { field: '$initiator.dept', op: 'inDeptTree', value: [1] },
      ],
    ])
    await flushPromises()
    expect(rows(w)[0]!.find('.wf-cond__value input[readonly]').element).toHaveProperty(
      'value',
      'Cat Ng',
    )
    expect(
      w.findAllComponents(ElTreeSelect).map((d) => d.find('input').attributes('aria-label')),
    ).toEqual(['Value', 'Value'])
  })

  it('an initiator-only form (no fields) starts with the department', async () => {
    const { w, when } = mountBuilder([], {})
    await button(w, 'Add a condition group').trigger('click')
    expect(when).toEqual([[{ field: '$initiator.dept', op: 'inDeptTree', value: [] }]])
    expect(await options(select(w, 0, 'field'))).toEqual([
      '[Initiator]',
      "Initiator's department",
      "Initiator's roles",
    ])
  })
})

describe('path drawer and field access', () => {
  const tree = (): WfBeginNode => ({
    id: 'begin',
    type: 'begin',
    name: 'Start',
    next: {
      id: 'f1',
      type: 'fork',
      name: 'Fork',
      paths: [
        { id: 'p1', name: 'Big', when: [] },
        { id: 'p2', name: 'Else', fallback: true, when: [] },
      ],
    },
  })
  async function mountDrawer(t: WfBeginNode, target: 'begin' | 'p1' | 'p2') {
    const f = t.next as WfForkNode
    const w = mount(WfNodeDrawer, {
      props: {
        modelValue: true,
        target:
          target === 'begin' ? { node: t } : { fork: f, path: f.paths[target === 'p1' ? 0 : 1]! },
        fields: FIELDS,
      },
      global: { plugins: [ElementPlus, i18n] },
      attachTo: document.body,
    })
    mounted.push(w)
    await flushPromises()
    return w
  }
  const drawer = () => new DOMWrapper(document.body).find('.wf-node-drawer')

  it('a conditional path gets the builder; what it builds publishes', async () => {
    const t = reactive(tree()) as WfBeginNode
    const w = await mountDrawer(t, 'p1')
    expect(drawer().find('.el-drawer__title').text()).toBe('Path settings')
    await drawer().find('input[name="name"]').setValue('Large amount')
    await button(w, 'Add a condition group').trigger('click')
    w.findComponent(ElInputNumber).vm.$emit('update:modelValue', 1000)
    await pick(w, 0, 'op', 'gt')
    await button(w, 'Add a condition group').trigger('click')
    await pick(w, 1, 'field', '$initiator.dept')
    w.findAllComponents(ElTreeSelect).at(-1)!.vm.$emit('update:modelValue', [1])
    await flushPromises()
    const f = t.next as WfForkNode
    expect(f.paths[0]).toEqual({
      id: 'p1',
      name: 'Large amount',
      when: [
        [{ field: 'amount', op: 'gt', value: 1000 }],
        [{ field: '$initiator.dept', op: 'inDeptTree', value: [1] }],
      ],
    })
    expect(compile(t, FIELDS).ok).toBe(true)
  })

  it('the fallback path and parallel paths have no conditions to set', async () => {
    const t = reactive(tree()) as WfBeginNode
    await mountDrawer(t, 'p2')
    expect(drawer().find('.wf-cond').exists()).toBe(false)
    expect(drawer().find('.wf-node-settings__hint').text()).toBe(
      'Taken when the conditions of no other path match.',
    )
    mounted.splice(0).forEach((w) => w.unmount())
    ;(t.next as WfForkNode).mode = 'parallel'
    await mountDrawer(t, 'p1')
    expect(drawer().find('.wf-cond').exists()).toBe(false)
    expect(drawer().find('.wf-node-settings__hint').text()).toBe('Runs alongside the other paths.')
  })

  it('field access: every form field read-only until set; one at a time or all at once', async () => {
    const t = reactive(tree()) as WfBeginNode
    const w = await mountDrawer(t, 'begin')
    expect(drawer().find('.el-drawer__title').text()).toBe('Initiator settings')
    const table = () => drawer().find('.wf-access')
    const state = () =>
      table()
        .findAll('.el-table__body .el-table__row')
        .map((r) => [
          r.find('td').text(),
          r
            .findAll('.el-radio')
            .map((x, i) => (x.classes('is-checked') ? ['edit', 'read', 'hide'][i] : null))
            .find(Boolean),
        ])
    expect(
      table()
        .findAll('.el-table__header th')
        .map((h) => h.text()),
    ).toEqual(['Field', 'Editable', 'Read-only', 'Hidden'])
    expect(state()).toEqual([
      ['amount', 'read'],
      ['reason', 'read'],
      ['startDate', 'read'],
      ['applicant', 'read'],
      ['costCenter', 'read'],
    ])
    const choose = (name: string) =>
      table()
        .findAll('.el-radio')
        .find((r) => r.text() === name)!
        .find('input')
        .setValue(true)
    await choose('amount Editable')
    await flushPromises()
    expect(t.access).toEqual({ amount: 'edit' })
    await choose('reason Hidden')
    await flushPromises()
    expect(t.access).toEqual({ amount: 'edit', reason: 'hide' })
    expect(state().slice(0, 2)).toEqual([
      ['amount', 'edit'],
      ['reason', 'hide'],
    ])
    await table()
      .findAll('.el-table__header button')
      .find((b) => b.text() === 'Editable')!
      .trigger('click')
    expect(t.access).toEqual({
      amount: 'edit',
      reason: 'edit',
      startDate: 'edit',
      applicant: 'edit',
      costCenter: 'edit',
    })
    expect(wfTree.safeParse(t).success).toBe(true)
    void w
  })
})
