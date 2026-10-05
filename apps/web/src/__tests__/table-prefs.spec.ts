// Column settings: merge rules, one read per table and session, debounced save, reset, and the
// QwTable / TableToolbar wiring, against the fake backend.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElButton, ElMessage, ElTable, ElTree } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import {
  mergeColumns,
  useTablePrefs,
  useTablePrefsStore,
  type ColumnSetting,
  type QwColumn,
} from '@/core/composables/use-table-prefs'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import { fail, mockApi, ok } from './mock-api'

const KEY = '/iam/profile/prefs/table.demo.note'
const columns: QwColumn[] = [
  { prop: 'code', label: 'field.iam.position.code', sortable: true },
  { prop: 'name', label: 'field.iam.position.name' },
  { prop: 'note', label: 'field.iam.position.note' },
]
type Row = { id: number; code: string; name: string; note: string }
const stored = (...columns: ColumnSetting[]) => ok({ value: { v: 1, columns } })
const shown = (p: ReturnType<typeof useTablePrefs>) => p.visibleColumns.value.map((c) => c.prop)
const sent = (calls: { method?: string; url?: string }[]) =>
  calls.map((c) => `${c.method?.toUpperCase()} ${c.url}`)

let error: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('zh-CN')
  accessToken.value = 'at'
  error = vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
})
afterEach(() => {
  useTablePrefsStore().clear() // no debounced save outlives its test
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('mergeColumns', () => {
  it('keeps the saved order of known columns, appends new ones visible, drops unknown ones', () => {
    expect(
      mergeColumns(
        ['a', 'b', 'c', 'd'],
        [
          { prop: 'c', visible: false },
          { prop: 'gone', visible: true },
          { prop: 'a', visible: true },
          { prop: 'c', visible: true },
        ],
      ),
    ).toEqual([
      { prop: 'c', visible: false },
      { prop: 'a', visible: true },
      { prop: 'b', visible: true },
      { prop: 'd', visible: true },
    ])
    expect(mergeColumns(['a', 'b'], null)).toEqual([
      { prop: 'a', visible: true },
      { prop: 'b', visible: true },
    ])
  })

  it('columns hidden by default stay hidden until the user shows them', () => {
    expect(mergeColumns(['a', 'b'], null, ['b'])).toEqual([
      { prop: 'a', visible: true },
      { prop: 'b', visible: false },
    ])
    expect(mergeColumns(['a', 'b'], [{ prop: 'b', visible: true }], ['b'])).toEqual([
      { prop: 'b', visible: true },
      { prop: 'a', visible: true },
    ])
  })
})

describe('useTablePrefs', () => {
  it('reads each table once per session; a failed read keeps the code columns without a toast', async () => {
    const calls = mockApi({
      [`GET ${KEY}`]: stored({ prop: 'note', visible: true }, { prop: 'code', visible: false }),
      'GET /iam/profile/prefs/table.demo.other': fail(500, 'B0001'),
    })
    const a = useTablePrefs('demo.note', columns)
    const b = useTablePrefs('demo.note', columns)
    expect(shown(a)).toEqual(['code', 'name', 'note']) // code defaults until the read lands
    await flushPromises()
    expect(shown(a)).toEqual(['note', 'name'])
    expect(b.settings.value).toEqual(a.settings.value)

    useTablePrefs('demo.note', columns)
    const other = useTablePrefs('demo.other', columns)
    await flushPromises()
    expect(shown(other)).toEqual(['code', 'name', 'note'])
    expect(error).not.toHaveBeenCalled()
    expect(sent(calls)).toEqual([`GET ${KEY}`, 'GET /iam/profile/prefs/table.demo.other'])

    // signing in or out starts a new session: read again
    useAuthStore().clear()
    accessToken.value = 'at'
    useTablePrefs('demo.note', columns)
    await flushPromises()
    expect(sent(calls)).toHaveLength(3)
  })

  it('applies a change at once and saves the last one 500 ms after the last change', async () => {
    const calls = mockApi({ [`GET ${KEY}`]: ok({ value: null }), [`PUT ${KEY}`]: ok(null) })
    const p = useTablePrefs('demo.note', columns)
    await flushPromises()
    vi.useFakeTimers()
    p.save([
      { prop: 'code', visible: false },
      { prop: 'name', visible: true },
      { prop: 'note', visible: true },
    ])
    vi.advanceTimersByTime(300)
    const last = [
      { prop: 'note', visible: true },
      { prop: 'code', visible: false },
      { prop: 'name', visible: false },
    ]
    p.save(last)
    expect(shown(p)).toEqual(['note'])
    vi.advanceTimersByTime(499)
    expect(sent(calls)).toEqual([`GET ${KEY}`])
    vi.advanceTimersByTime(1)
    vi.useRealTimers()
    await vi.waitFor(() => expect(sent(calls)).toEqual([`GET ${KEY}`, `PUT ${KEY}`]))
    expect(JSON.parse(calls[1]!.data as string)).toEqual({ value: { v: 1, columns: last } })
  })

  it('reset deletes the stored settings, drops a pending save and restores the code columns', async () => {
    const calls = mockApi({
      [`GET ${KEY}`]: stored({ prop: 'name', visible: false }),
      [`PUT ${KEY}`]: ok(null),
      [`DELETE ${KEY}`]: ok(null),
    })
    const p = useTablePrefs('demo.note', columns)
    await flushPromises()
    expect(shown(p)).toEqual(['code', 'note'])
    vi.useFakeTimers()
    p.save([{ prop: 'note', visible: true }])
    await p.reset()
    vi.advanceTimersByTime(1000)
    vi.useRealTimers()
    await flushPromises()
    expect(sent(calls)).toEqual([`GET ${KEY}`, `DELETE ${KEY}`])
    expect(shown(p)).toEqual(['code', 'name', 'note'])
  })
})

describe('useTablePrefs: save and reset in order', () => {
  it('a reset waits for the save in flight, so its DELETE is the last word', async () => {
    let finishPut = () => {}
    const calls = mockApi({
      [`GET ${KEY}`]: ok({ value: null }),
      [`PUT ${KEY}`]: () => new Promise((r) => (finishPut = () => r(ok(null)))),
      [`DELETE ${KEY}`]: ok(null),
    })
    const p = useTablePrefs('demo.note', columns)
    await flushPromises()
    vi.useFakeTimers()
    p.save([{ prop: 'code', visible: false }])
    vi.advanceTimersByTime(500)
    vi.useRealTimers()
    await vi.waitFor(() => expect(sent(calls)).toEqual([`GET ${KEY}`, `PUT ${KEY}`]))

    const reset = p.reset()
    expect(shown(p)).toEqual(['code', 'name', 'note']) // applies at once
    await flushPromises()
    expect(sent(calls)).toEqual([`GET ${KEY}`, `PUT ${KEY}`]) // the DELETE waits for the PUT
    finishPut()
    await reset
    expect(sent(calls)).toEqual([`GET ${KEY}`, `PUT ${KEY}`, `DELETE ${KEY}`])
    expect(shown(p)).toEqual(['code', 'name', 'note'])
  })

  it('a failed reset shows the columns again, and still saves a change it had cancelled', async () => {
    const calls = mockApi({
      [`GET ${KEY}`]: stored({ prop: 'name', visible: false }),
      [`PUT ${KEY}`]: ok(null),
      [`DELETE ${KEY}`]: fail(500, 'B0001'),
    })
    const p = useTablePrefs('demo.note', columns)
    await flushPromises()
    await p.reset()
    expect(shown(p)).toEqual(['code', 'note'])
    expect(error).toHaveBeenCalledTimes(1) // the request layer's toast

    vi.useFakeTimers()
    p.save([{ prop: 'note', visible: true }])
    const reset = p.reset() // drops the pending save, then fails
    vi.useRealTimers()
    await reset
    expect(shown(p)).toEqual(['note', 'code', 'name'])
    await vi.waitFor(() => expect(sent(calls).at(-1)).toBe(`PUT ${KEY}`), { timeout: 2000 })
    expect(JSON.parse(calls.at(-1)!.data as string)).toEqual({
      value: { v: 1, columns: [{ prop: 'note', visible: true }] },
    })
  })
})

describe('QwTable', () => {
  it('renders the visible columns in the user order, cell and action slots; events pass through', async () => {
    mockApi({
      [`GET ${KEY}`]: stored({ prop: 'note', visible: true }, { prop: 'code', visible: false }),
    })
    const onSortChange = vi.fn<(sort: { prop: string; order: string }) => void>()
    const wrapper = mount(QwTable, {
      props: {
        tableId: 'demo.note',
        columns,
        data: [{ id: 1, code: 'c-1', name: 'first', note: 'n-1' }],
        selection: true,
        onSortChange,
      },
      slots: {
        'cell-name': ({ row }: { row: object }) => h('b', (row as Row).name.toUpperCase()),
        actions: ({ row }: { row: object }) => h('button', { class: 'edit' }, (row as Row).id),
      },
      global: { plugins: [ElementPlus, i18n] },
    })
    await flushPromises()
    const header = wrapper.findAll('.el-table__header th').map((th) => th.text())
    expect(header).toEqual(['', '备注', '岗位名称', '操作'])
    const cells = wrapper.findAll('.el-table__body tr td').map((td) => td.text())
    expect(cells).toEqual(['', 'n-1', 'FIRST', '1'])
    expect(wrapper.find('.el-table__body .edit').exists()).toBe(true)

    wrapper.findComponent(ElTable).vm.$emit('sort-change', { prop: 'code', order: 'ascending' })
    expect(onSortChange).toHaveBeenCalledWith({ prop: 'code', order: 'ascending' })
  })
})

describe('TableToolbar column settings', () => {
  it('ticks show, drops reorder (never inside another column), reset restores', async () => {
    const calls = mockApi({ [`GET ${KEY}`]: ok({ value: null }), [`DELETE ${KEY}`]: ok(null) })
    const wrapper = mount(TableToolbar, {
      props: { tableId: 'demo.note', columns },
      global: { plugins: [ElementPlus, i18n] },
      attachTo: document.body,
    })
    await flushPromises()
    await wrapper.get('button[aria-label="列设置"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.findComponent(ElTree).exists()).toBe(true))
    const tree = wrapper.findComponent(ElTree)
    expect(tree.props('data')).toEqual([
      { prop: 'code', label: '岗位编码' },
      { prop: 'name', label: '岗位名称' },
      { prop: 'note', label: '备注' },
    ])
    const allowDrop = tree.props('allowDrop') as (a: unknown, b: unknown, t: string) => boolean
    expect(['prev', 'next', 'inner'].map((type) => allowDrop(null, null, type))).toEqual([
      true,
      true,
      false,
    ])

    const prefs = useTablePrefs('demo.note', columns)
    tree.vm.$emit('check', {}, { checkedKeys: ['code', 'note'] })
    expect(prefs.settings.value).toEqual([
      { prop: 'code', visible: true },
      { prop: 'name', visible: false },
      { prop: 'note', visible: true },
    ])
    const drop = (from: string, to: string, type: string) =>
      tree.vm.$emit(
        'node-drop',
        { data: { prop: from } },
        { data: { prop: to } },
        type,
        new Event('drop'),
      )
    drop('note', 'code', 'before')
    expect(shown(prefs)).toEqual(['note', 'code'])
    drop('code', 'name', 'after')
    expect(prefs.settings.value.map((s) => s.prop)).toEqual(['note', 'name', 'code'])

    // the popover content is teleported: find the button by component
    const reset = wrapper.findAllComponents(ElButton).find((b) => b.text() === '恢复默认')
    await reset?.trigger('click')
    await flushPromises()
    expect(shown(prefs)).toEqual(['code', 'name', 'note'])
    expect(sent(calls)).toEqual([`GET ${KEY}`, `DELETE ${KEY}`])
    wrapper.unmount()
  })
})
