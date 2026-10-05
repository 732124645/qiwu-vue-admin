// The user page's side tree and pickers (see docs/design-notes.md#layering): TreePanel, DeptTreeSelect and UserPicker (opened with
// openDialog), against the fake backend.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref, type Component } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElTreeSelect } from 'element-plus'
import type { DeptTreeNode, UserOption } from '@qiwu/shared'
import DeptTreeSelect from '@/core/components/DeptTreeSelect.vue'
import TreePanel from '@/core/components/TreePanel.vue'
import UserPicker from '@/core/components/UserPicker.vue'
import UserSelect from '@/core/components/UserSelect.vue'
import { dialogs, openDialog } from '@/core/dialog'
import DialogHost from '@/core/dialog/DialogHost.vue'
import { i18n, setLocale, tx } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import { mockApi, ok } from './mock-api'

const dept = (id: number, parentId: number, key: string, children: DeptTreeNode[] = []) => ({
  id,
  parentId,
  name: `seed.dept.${key}`,
  children,
})
// hq > rd > (platform, product); ops is admin-created (plain text)
const DEPTS: DeptTreeNode[] = [
  dept(1, 0, 'hq', [dept(2, 1, 'rd', [dept(3, 2, 'platform'), dept(4, 2, 'product')])]),
  { id: 5, parentId: 0, name: 'Night shift', children: [] },
]
const SUBTREE: Record<number, number[]> = { 1: [1, 2, 3, 4], 2: [2, 3, 4], 3: [3], 4: [4], 5: [5] }
const USERS: (UserOption & { deptId: number })[] = [
  { id: 1, username: 'ann', displayName: 'Ann Lee', deptName: 'seed.dept.platform', deptId: 3 },
  { id: 2, username: 'bob', displayName: 'Bob Wu', deptName: 'seed.dept.product', deptId: 4 },
  { id: 3, username: 'cat', displayName: 'Cat Ng', deptName: 'seed.dept.platform', deptId: 3 },
  { id: 4, username: 'dan', displayName: 'Dan Ho', deptName: 'Night shift', deptId: 5 },
]
const option = ({ id, username, displayName, deptName }: UserOption): UserOption => ({
  id,
  username,
  displayName,
  deptName,
})

/** The fake backend: the dept tree and GET /iam/users/options filtered like the server (dept subtree, keyword). */
function backend(users = USERS) {
  return mockApi({
    'GET /iam/depts/tree': ok(DEPTS),
    'GET /iam/users/options': (c) => {
      const { deptId, keyword } = (c.params ?? {}) as { deptId?: number; keyword?: string }
      return ok(
        users
          .filter((u) => deptId == null || SUBTREE[deptId]?.includes(u.deptId))
          .filter(
            (u) => !keyword || `${u.username} ${u.displayName}`.toLowerCase().includes(keyword),
          )
          .map(option),
      )
    },
  })
}
const params = (calls: { url?: string; params?: unknown }[]) =>
  calls.filter((c) => c.url === '/iam/users/options').map((c) => c.params)

beforeEach(() => {
  setLocale('en-US')
  accessToken.value = 'at'
  localStorage.clear()
  vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('TreePanel', () => {
  function panel(props: Record<string, unknown> = {}) {
    const selected = ref<number | null>(null)
    const w = mount(
      defineComponent({
        setup: () => () =>
          h(
            TreePanel as Component,
            {
              data: DEPTS,
              label: (d: DeptTreeNode) => tx(d.name),
              title: 'Departments',
              storageKey: 'test',
              modelValue: selected.value,
              'onUpdate:modelValue': (v: number | null) => (selected.value = v),
              ...props,
            },
            { default: () => h('p', { class: 'content' }, 'page content') },
          ),
      }),
      { global: { plugins: [ElementPlus, i18n] }, attachTo: document.body },
    )
    return { w, selected }
  }
  const labels = (w: VueWrapper) =>
    w
      .findAll('.el-tree-node__content')
      .filter((n) => n.isVisible())
      .map((n) => n.text())
  const current = (w: VueWrapper) => w.find('.el-tree-node.is-current > .el-tree-node__content')
  const node = (w: VueWrapper, text: string) =>
    w.findAll('.el-tree-node__content').find((n) => n.text() === text)!

  it('shows the tree beside the content; a click selects a node, a second click clears it', async () => {
    const { w, selected } = panel()
    await flushPromises()
    expect(w.find('.tree-panel__main .content').exists()).toBe(true)
    expect(labels(w)).toEqual([
      'Headquarters',
      'R&D Center',
      'Platform Team',
      'Product Team',
      'Night shift',
    ])

    await node(w, 'R&D Center').trigger('click')
    expect(selected.value).toBe(2)
    expect(current(w).text()).toBe('R&D Center')
    await node(w, 'R&D Center').trigger('click')
    await flushPromises()
    expect(selected.value).toBeNull()
    expect(current(w).exists()).toBe(false)

    // set from outside (a page's reset, a saved query): the highlight follows
    selected.value = 3
    await flushPromises()
    expect(current(w).text()).toBe('Platform Team')
    selected.value = null
    await flushPromises()
    expect(current(w).exists()).toBe(false)
  })

  it('filters by the shown label, keeping the path to each match', async () => {
    const { w } = panel()
    await w.find('.tree-panel__filter input').setValue('PLAT')
    await flushPromises()
    expect(labels(w)).toEqual(['Headquarters', 'R&D Center', 'Platform Team'])
    await w.find('.tree-panel__filter input').setValue('nothing')
    await flushPromises()
    expect(labels(w)).toEqual([])
    expect(w.find('.el-tree__empty-text').text()).toBe('No matching results')
  })

  it('resizes by drag and arrow keys within 200–480 px and collapses to a rail, kept per storage key', async () => {
    const { w } = panel()
    const aside = () => w.find('.tree-panel__aside').element as HTMLElement
    const saved = () => JSON.parse(localStorage.getItem('qw.tree-panel.test') ?? '{}') as object
    const handle = w.find('[role="separator"]')
    expect(aside().style.width).toBe('240px')
    expect(handle.attributes()).toMatchObject({
      'aria-valuenow': '240',
      'aria-label': 'Resize Departments',
    })

    await handle.trigger('pointerdown', { clientX: 100, pointerId: 1 })
    await handle.trigger('pointermove', { clientX: 160, pointerId: 1 })
    expect(aside().style.width).toBe('300px')
    await handle.trigger('pointerup', { pointerId: 1 })
    await handle.trigger('pointermove', { clientX: 400, pointerId: 1 })
    expect(aside().style.width).toBe('300px')

    await handle.trigger('keydown', { key: 'ArrowRight' })
    expect(aside().style.width).toBe('316px')
    for (let i = 0; i < 10; i++) await handle.trigger('keydown', { key: 'ArrowLeft' })
    expect(aside().style.width).toBe('200px')
    expect(saved()).toMatchObject({ width: 200, collapsed: false })

    await w.find('[aria-label="Collapse Departments"]').trigger('click')
    expect(w.find('.el-tree').exists()).toBe(false)
    expect(saved()).toMatchObject({ collapsed: true })
    w.unmount()

    const again = panel().w
    expect(again.find('.tree-panel__rail').exists()).toBe(true)
    await again.find('[aria-label="Expand Departments"]').trigger('click')
    expect(again.find('.tree-panel__aside').attributes('style')).toContain('width: 200px')
  })
})

describe('DeptTreeSelect', () => {
  it('loads the tree, names seeded depts in the current language, emits the id and null when cleared', async () => {
    const calls = backend()
    const value = ref<number | null>(3)
    const w = mount(
      defineComponent({
        setup: () => () =>
          h(DeptTreeSelect, {
            modelValue: value.value,
            'onUpdate:modelValue': (v: number | number[] | null | undefined) =>
              (value.value = typeof v === 'number' ? v : null),
          }),
      }),
      { global: { plugins: [ElementPlus, i18n] }, attachTo: document.body },
    )
    await flushPromises()
    expect(calls.map((c) => c.url)).toEqual(['/iam/depts/tree'])
    const select = w.findComponent(ElTreeSelect)
    const names = () =>
      (select.props('data') as { label: string; children: { label: string }[] }[]).map((o) => [
        o.label,
        o.children.map((c) => c.label),
      ])
    expect(names()).toEqual([
      ['Headquarters', ['R&D Center']],
      ['Night shift', []],
    ])
    // the label of the loaded value
    expect(w.find('.el-select__placeholder').text()).toBe('Platform Team')

    setLocale('zh-CN')
    await flushPromises()
    expect(names()[0]?.[0]).toBe(i18n.global.t('seed.dept.hq'))

    select.vm.$emit('update:modelValue', 4)
    expect(value.value).toBe(4)
    await w.find('.el-select').trigger('mouseenter')
    await w.find('.el-select__clear').trigger('click')
    expect(value.value).toBeNull()
  })
})

describe('UserPicker', () => {
  let host: VueWrapper
  beforeEach(async () => {
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
    host.unmount()
    dialogs.splice(0)
  })

  // the dialog is teleported to <body>
  const body = () => new DOMWrapper(document.body)
  const rows = () => body().findAll('.el-table__body .el-table__row')
  const row = (name: string) => rows().find((r) => r.text().includes(name))!
  const names = () => rows().map((r) => r.findAll('td')[1]?.text())
  const tags = () =>
    body()
      .findAll('.user-picker__picked .el-tag')
      .map((t) => t.text())
  const footer = () => body().findAll('.qw-dialog-footer button')
  const deptNode = (text: string) =>
    body()
      .findAll('.el-tree-node__content')
      .find((n) => n.text() === text)!

  it('multiple: filters by dept subtree and keyword, keeps picks across searches, resolves with them', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const calls = backend()
    const result = openDialog<UserOption[]>(UserPicker, { multiple: true }, { width: 880 })
    await flushPromises()
    expect(names()).toEqual(['Ann Lee', 'Bob Wu', 'Cat Ng', 'Dan Ho'])
    // seeded dept names are keys, admin-created ones text
    expect(row('Ann Lee').text()).toContain('Platform Team')
    expect(row('Dan Ho').text()).toContain('Night shift')
    expect(footer()[1]?.attributes('disabled')).toBeDefined()

    await row('Ann Lee').trigger('click')
    const checked = () =>
      body()
        .findAll('.el-dialog .el-checkbox__input')
        .map((c) => (c.classes('is-indeterminate') ? '-' : c.classes('is-checked') ? 'x' : ' '))
    // header box first: some listed users picked
    expect(checked()).toEqual(['-', 'x', ' ', ' ', ' '])
    await deptNode('Product Team').trigger('click')
    await flushPromises()
    expect(names()).toEqual(['Bob Wu'])
    await row('Bob Wu').find('.el-checkbox input').setValue(true)
    expect(tags()).toEqual(['Ann Lee', 'Bob Wu'])

    // R&D covers its subtree; the keyword waits for typing to pause
    await deptNode('R&D Center').trigger('click')
    await body().find('input[name="keyword"]').setValue('cat')
    await flushPromises()
    expect(names()).toEqual(['Ann Lee', 'Bob Wu', 'Cat Ng'])
    vi.advanceTimersByTime(300)
    await flushPromises()
    expect(names()).toEqual(['Cat Ng'])
    expect(params(calls)).toEqual([{}, { deptId: 4 }, { deptId: 2 }, { deptId: 2, keyword: 'cat' }])

    // the header box picks every listed user; a picked row clicked again is dropped
    await body().find('.el-table__header .el-checkbox input').setValue(true)
    expect(tags()).toEqual(['Ann Lee', 'Bob Wu', 'Cat Ng'])
    expect(checked()).toEqual(['x', 'x'])
    await row('Cat Ng').trigger('click')
    expect(tags()).toEqual(['Ann Lee', 'Bob Wu'])
    await body().findAll('.user-picker__picked .el-tag__close')[0]!.trigger('click')
    expect(tags()).toEqual(['Bob Wu'])
    expect(body().find('.user-picker__count').text()).toBe('1 selected')

    await footer()[1]!.trigger('click')
    await expect(result).resolves.toEqual([option(USERS[1]!)])
  })

  it('single: a click replaces the pick, a double click picks and confirms', async () => {
    backend()
    const first = openDialog<UserOption[]>(UserPicker, {})
    await flushPromises()
    expect(body().find('.el-table__header .el-checkbox').exists()).toBe(false)
    await row('Ann Lee').trigger('click')
    await row('Cat Ng').trigger('click')
    expect(tags()).toEqual(['Cat Ng'])
    expect(row('Cat Ng').find('.el-radio').classes()).toContain('is-checked')
    expect(row('Ann Lee').find('.el-radio').classes()).not.toContain('is-checked')
    await footer()[1]!.trigger('click')
    await expect(first).resolves.toEqual([option(USERS[2]!)])
    await vi.waitFor(() => expect(dialogs).toHaveLength(0))

    const second = openDialog<UserOption[]>(UserPicker, {})
    await flushPromises()
    await row('Dan Ho').trigger('dblclick')
    await expect(second).resolves.toEqual([option(USERS[3]!)])
  })

  it('starts with the given picks, says when the list is cut at 200, cancel resolves undefined', async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      id: 100 + i,
      username: `u${i}`,
      displayName: `User ${i}`,
      deptName: null,
      deptId: 1,
    }))
    backend(many)
    const result = openDialog<UserOption[]>(UserPicker, {
      multiple: true,
      selected: [option(USERS[0]!)],
    })
    await flushPromises()
    expect(tags()).toEqual(['Ann Lee'])
    expect(body().find('.user-picker__hint').text()).toBe(
      'Showing the first 200. Narrow the search to find others.',
    )
    await footer()[0]!.trigger('click')
    await expect(result).resolves.toBeUndefined()
  })

  it('UserSelect: a user id as a field, picked in UserPicker, shown by name once picked, cleared to null', async () => {
    backend()
    const model = ref<number | null>(9)
    const w = mount(
      defineComponent({
        setup: () => () =>
          h(UserSelect, {
            modelValue: model.value,
            'onUpdate:modelValue': (v: number | null | undefined) => (model.value = v ?? null),
          }),
      }),
      { global: { plugins: [ElementPlus, i18n] }, attachTo: document.body },
    )
    const input = () => w.find('input').element as HTMLInputElement
    // an id that came with the row: no name at hand
    expect(input().value).toBe('#9')
    await w.find('.el-input-group__append button').trigger('click')
    await flushPromises()
    await row('Cat Ng').trigger('dblclick')
    await flushPromises()
    expect(model.value).toBe(3)
    expect(input().value).toBe('Cat Ng (cat)')
    await w.find('button[aria-label="Clear the selected user"]').trigger('click')
    expect(model.value).toBeNull()
    expect(input().value).toBe('')
    w.unmount()
  })

  it('source wf (process dialogs): every enabled user from /wf/users/options, no dept tree or usernames', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // the caller's scope (own_rows) holds only themselves; the process list every colleague
    const calls = mockApi({
      'GET /iam/depts/tree': ok([]),
      'GET /iam/users/options': ok([option(USERS[0]!)]),
      'GET /wf/users/options': (c) => {
        const { keyword } = (c.params ?? {}) as { keyword?: string }
        return ok(
          USERS.filter((u) => !keyword || u.displayName.toLowerCase().includes(keyword)).map(
            ({ id, displayName, deptName }) => ({ id, displayName, deptName }),
          ),
        )
      },
    })
    const model = ref<number | null>(null)
    const w = mount(
      defineComponent({
        setup: () => () =>
          h(UserSelect, {
            modelValue: model.value,
            source: 'wf',
            'onUpdate:modelValue': (v: number | null | undefined) => (model.value = v ?? null),
          }),
      }),
      { global: { plugins: [ElementPlus, i18n] }, attachTo: document.body },
    )
    await w.find('.el-input-group__append button').trigger('click')
    await flushPromises()
    expect(names()).toEqual(['Ann Lee', 'Bob Wu', 'Cat Ng', 'Dan Ho'])
    expect(body().find('.tree-panel').exists()).toBe(false)
    expect(
      body()
        .findAll('.el-table__header th')
        .map((th) => th.text()),
    ).not.toContain('Username')
    await body().find('input[name="keyword"]').setValue('bob')
    vi.advanceTimersByTime(300)
    await flushPromises()
    expect(names()).toEqual(['Bob Wu'])
    expect(calls.map((c) => c.url)).toEqual(['/wf/users/options', '/wf/users/options'])
    await row('Bob Wu').trigger('dblclick')
    await flushPromises()
    expect(model.value).toBe(2)
    expect((w.find('input').element as HTMLInputElement).value).toBe('Bob Wu')
    w.unmount()
  })
})
