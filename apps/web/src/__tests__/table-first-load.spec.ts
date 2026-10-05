import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, type Component } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import QwTable from '@/core/components/QwTable.vue'
import { useCrudList } from '@/core/composables/use-crud'
import { useTablePrefsStore, type QwColumn } from '@/core/composables/use-table-prefs'
import { i18n, setLocale } from '@/core/i18n'
import elementCss from '@/styles/element.css?raw'
import { mockApi, ok } from './mock-api'

const TABLE = 'demo.polish'
const PREFS = `GET /iam/profile/prefs/table.${TABLE}`
const columns: QwColumn[] = [
  { prop: 'name', label: 'field.iam.position.name', width: 180 },
  { prop: 'note', label: 'field.iam.position.note', minWidth: 240 },
]
const row = { id: 1, name: 'Real row', note: 'Real note' }
type Row = typeof row
type Page = { items: Row[]; total: number }
const wrappers: VueWrapper[] = []
const global = { plugins: [ElementPlus, i18n] }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('zh-CN')
  mockApi({ [PREFS]: ok({ value: null }) })
})
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount())
  useTablePrefsStore().clear()
  vi.restoreAllMocks()
})

describe('first table load', () => {
  it.each(['empty', 'failed', 'rows'])(
    '%s finishes the first request, later refreshes keep the table',
    async (result) => {
      const first = deferred<Page>()
      const second = deferred<Page>()
      const page = vi
        .fn<() => Promise<Page>>()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
      let list!: ReturnType<typeof useCrudList<Row>>
      const Host = defineComponent({
        setup() {
          list = useCrudList<Row>({ api: { page } })
          return () =>
            h(QwTable as Component, {
              tableId: TABLE,
              columns,
              data: list.rows.value,
              loading: list.loading.value,
            })
        },
      })
      const wrapper = mount(Host, { global })
      wrappers.push(wrapper)
      await flushPromises()
      expect(wrapper.find('.qw-table-skeleton').attributes('aria-busy')).toBe('true')
      expect(wrapper.findAll('.qw-table-skeleton__row')).toHaveLength(5)
      expect(wrapper.findComponent({ name: 'ElTable' }).exists()).toBe(false)
      expect(wrapper.find('[role="status"]').text()).toBe(i18n.global.t('crud.loading'))
      setLocale('en-US')
      await flushPromises()
      expect(wrapper.find('[role="status"]').text()).toBe('Loading')

      if (result === 'failed') first.reject(new Error('Request failed'))
      else
        first.resolve({ items: result === 'rows' ? [row] : [], total: result === 'rows' ? 1 : 0 })
      await flushPromises()
      expect(wrapper.find('.qw-table-skeleton').exists()).toBe(false)
      const table = wrapper.findComponent({ name: 'ElTable' })
      expect(table.exists()).toBe(true)
      expect(table.props('data')).toEqual(result === 'rows' ? [row] : [])

      const refresh = list.refresh()
      await flushPromises()
      expect(wrapper.find('.qw-table-skeleton').exists()).toBe(false)
      expect(wrapper.findComponent({ name: 'ElTable' }).element).toBe(table.element)
      expect(wrapper.findComponent({ name: 'ElTable' }).props('data')).toEqual(
        result === 'rows' ? [row] : [],
      )
      expect(wrapper.find('.el-loading-mask').exists()).toBe(true)
      expect(wrapper.find('.el-table__body').text()).toBe(
        result === 'rows' ? `${row.name}${row.note}` : '',
      )
      second.resolve({ items: [row], total: 1 })
      await refresh
      await flushPromises()
      expect(wrapper.findComponent({ name: 'ElTable' }).props('data')).toEqual([row])
    },
  )

  it('can start the first load after mounting idle', async () => {
    const wrapper = mount(QwTable, {
      props: { tableId: TABLE, columns, data: [], loading: false },
      global,
    })
    wrappers.push(wrapper)
    await flushPromises()
    expect(wrapper.find('.qw-table-skeleton').exists()).toBe(false)
    await wrapper.setProps({ loading: true })
    expect(wrapper.find('.qw-table-skeleton').exists()).toBe(true)
    await wrapper.setProps({ loading: false })
    await wrapper.setProps({ loading: true })
    expect(wrapper.find('.qw-table-skeleton').exists()).toBe(false)
  })

  it('uses restored visible columns and widths without invoking row slots or forwarding events to the skeleton', async () => {
    const prefs = deferred<ReturnType<typeof ok>>()
    mockApi({ [PREFS]: () => prefs.promise })
    const cell = vi.fn<(scope: { row: object }) => ReturnType<typeof h>>(({ row }) =>
      h('b', (row as Row).note),
    )
    const remove = vi.fn<() => void>()
    const actions = vi.fn<(scope: { row: object }) => ReturnType<typeof h>>(({ row }) =>
      h('button', { onClick: remove }, (row as Row).name),
    )
    const onSelectionChange = vi.fn<(rows: Row[]) => void>()
    const onSortChange = vi.fn<(sort: { prop: string; order: string }) => void>()
    const wrapper = mount(QwTable, {
      props: {
        tableId: TABLE,
        columns,
        data: [row],
        loading: true,
        selection: true,
        onSelectionChange,
        onSortChange,
      },
      slots: { 'cell-note': cell, actions },
      global,
    })
    wrappers.push(wrapper)
    await flushPromises()
    const cells = () => wrapper.find('.qw-table-skeleton__row').findAll('[data-column]')
    expect(cells().map((c) => c.attributes('data-column'))).toEqual(['name', 'note'])
    expect(cells()[0]!.attributes('style')).toContain('180px')
    expect(cells()[1]!.attributes('style')).toContain('240px')
    prefs.resolve(
      ok({
        value: {
          v: 1,
          columns: [
            { prop: 'note', visible: true },
            { prop: 'gone', visible: true },
            { prop: 'name', visible: false },
          ],
        },
      }),
    )
    await flushPromises()
    expect(cells().map((c) => c.attributes('data-column'))).toEqual(['note'])
    expect(wrapper.find('.el-skeleton').attributes()).toMatchObject({
      'aria-hidden': 'true',
      inert: '',
    })
    expect(wrapper.find('button, input').exists()).toBe(false)
    await wrapper.find('.qw-table-skeleton').trigger('click')
    await wrapper.find('.qw-table-skeleton').trigger('selection-change')
    expect(cell).not.toHaveBeenCalled()
    expect(actions).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(onSelectionChange).not.toHaveBeenCalled()

    await wrapper.setProps({ loading: false })
    await flushPromises()
    expect(wrapper.find('.el-table__body').text()).toContain(row.note)
    expect(wrapper.find('.el-table__header').text()).not.toContain(i18n.global.t(columns[0]!.label))
    expect(cell).toHaveBeenCalled()
    wrapper.findComponent({ name: 'ElTable' }).vm.$emit('selection-change', [row])
    wrapper
      .findComponent({ name: 'ElTable' })
      .vm.$emit('sort-change', { prop: 'note', order: 'ascending' })
    expect(onSelectionChange).toHaveBeenCalledWith([row])
    expect(onSortChange).toHaveBeenCalledWith({ prop: 'note', order: 'ascending' })
    await wrapper.find('.el-table__body button').trigger('click')
    expect(remove).toHaveBeenCalledOnce()
  })
})

it('separates every shared dialog footer with the design border token', () => {
  const footer = /:root \.qw-dialog-footer\s*\{([^}]+)\}/.exec(elementCss)?.[1]
  expect(footer).toMatch(/border-top:\s*1px solid var\(--qw-border\)/)
  expect(footer).toMatch(/padding-top:\s*16px/)
  expect(footer).toMatch(/margin-top:\s*16px/)
})
