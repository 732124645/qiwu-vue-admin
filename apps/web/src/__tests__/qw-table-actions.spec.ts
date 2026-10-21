import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref, withDirectives, type Component, type VNode } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElButton, ElDropdown, ElMessageBox, ElPopconfirm } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import type { MePayload } from '@qiwu/shared'
import IconButton from '@/core/components/IconButton.vue'
import QwTable from '@/core/components/QwTable.vue'
import { useTablePrefsStore, type QwColumn } from '@/core/composables/use-table-prefs'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { appSettings } from '@/core/stores/app'
import { useAuthStore } from '@/core/stores/auth'
import TopicPage from '@/views/demo/topic/index.vue'
import { mockApi, ok } from './mock-api'

const TABLE = 'demo.actions'
const columns: QwColumn[] = [{ prop: 'name', label: 'field.iam.position.name' }]
const rows = [{ id: 1, name: 'Row one' }]
const wrappers: VueWrapper[] = []
const global = { plugins: [ElementPlus, i18n], directives: { perm: vPerm } }
// the cell's horizontal padding (element.css `.el-table .cell`: 0 16px) + the column's 2px slack
const CELL = 32 + 2

type Spec = {
  label: string
  type?: 'primary' | 'danger'
  perm?: string
  disabled?: boolean
  loading?: boolean
  onClick?: (e: MouseEvent) => void
  onClickOnce?: (e: MouseEvent) => void
}
const button = (s: Spec): VNode => {
  // `link: ''` as a template's bare `link` attribute arrives
  const node = h(
    ElButton as Component,
    {
      link: '',
      type: s.type ?? 'primary',
      disabled: s.disabled,
      loading: s.loading,
      onClick: s.onClick,
      onClickOnce: s.onClickOnce,
    },
    () => s.label,
  )
  return s.perm ? withDirectives(node, [[vPerm, s.perm]]) : node
}

function mountSlot(
  actions: (scope: { row: never }) => unknown,
  props: Record<string, unknown> = {},
) {
  const wrapper = mount(
    defineComponent({
      render: () =>
        h(QwTable as Component, { tableId: TABLE, columns, data: rows, ...props }, { actions }),
    }),
    { global, attachTo: document.body },
  )
  wrappers.push(wrapper)
  return wrapper
}
const mountTable = (specs: Spec[], props: Record<string, unknown> = {}) =>
  mountSlot(() => specs.map(button), props)

/** The labels of the inline buttons of the first row, the "More" trigger excluded. */
const inline = (w: VueWrapper) =>
  w
    .findAll('.el-table__body .el-button')
    .filter((b) => !b.element.closest('.qw-table-more'))
    .map((b) => b.text())
const labels = (items: HTMLElement[]) => items.map((e) => e.textContent?.trim())
const width = (w: VueWrapper) =>
  Number(w.findAllComponents({ name: 'ElTableColumn' }).at(-1)!.props('width'))

/** Opens the first row's "More" from the keyboard and returns its menu items. */
async function openMore(w: VueWrapper) {
  const trigger = w.find('.el-table__body .qw-table-more .el-button')
  await trigger.trigger('keydown', { code: 'Enter', key: 'Enter' })
  // Element Plus opens after its default show timeout (150 ms)
  await new Promise((resolve) => setTimeout(resolve, 200))
  await flushPromises()
  const menu = document.getElementById(trigger.attributes('aria-controls')!)!
  return [...menu.querySelectorAll<HTMLElement>('.el-dropdown-menu__item')]
}

/** Lets the measurement scheduled for the next frame run. */
async function nextFrame() {
  await flushPromises()
  await new Promise((resolve) => requestAnimationFrame(resolve))
  await flushPromises()
}

/** Fake layout (happy-dom has none): every button in an actions container is `per` px wide. */
function fakeLayout(per = 50) {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('qw-table-actions')
      ? this.querySelectorAll('button').length * per
      : 0
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('zh-CN')
  mockApi({ [`GET /iam/profile/prefs/table.${TABLE}`]: ok({ value: null }) })
  useAuthStore().me = { perms: ['*'] } as unknown as MePayload
})
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount())
  document.body.innerHTML = ''
  useTablePrefsStore().clear()
  appSettings.value.tableActionsVisible = 2
  vi.restoreAllMocks()
})

describe('QwTable row actions', () => {
  it('shows two buttons inline and the rest in a hover / keyboard More by default', async () => {
    const w = mountTable([
      { label: '查看' },
      { label: '编辑' },
      { label: '复制' },
      { label: '导出' },
    ])
    await flushPromises()
    expect(inline(w)).toEqual(['查看', '编辑'])
    expect(w.find('.qw-table-more').text()).toContain(i18n.global.t('crud.action.more'))
    const more = w.findComponent(ElDropdown)
    expect(more.props('trigger')).toBe('hover')
    expect(more.props('persistent')).toBe(false)
    expect(labels(await openMore(w))).toEqual(['复制', '导出'])
    // a click on the trigger of an open menu leaves it open
    const trigger = w.find('.el-table__body .qw-table-more .el-button')
    await trigger.trigger('click')
    await flushPromises()
    expect(trigger.attributes('aria-expanded')).toBe('true')
  })

  it('keeps two buttons or fewer inline without More', async () => {
    const w = mountTable([{ label: '编辑' }, { label: '删除', type: 'danger' }])
    await flushPromises()
    expect(inline(w)).toEqual(['编辑', '删除'])
    expect(w.find('.qw-table-more').exists()).toBe(false)
  })

  it('takes the per-table actions-visible over the default; Infinity never adds More', async () => {
    const w = mountTable([{ label: '查看' }, { label: '编辑' }, { label: '复制' }], {
      actionsVisible: 1,
    })
    const all = mountTable([{ label: '查看' }, { label: '编辑' }, { label: '复制' }], {
      actionsVisible: Infinity,
    })
    await flushPromises()
    expect(inline(w)).toEqual(['查看'])
    expect(labels(await openMore(w))).toEqual(['编辑', '复制'])
    expect(inline(all)).toEqual(['查看', '编辑', '复制'])
    expect(all.find('.qw-table-more').exists()).toBe(false)
  })

  it('follows a change of the global default', async () => {
    const w = mountTable([{ label: '查看' }, { label: '编辑' }, { label: '复制' }])
    await flushPromises()
    expect(inline(w)).toEqual(['查看', '编辑'])
    appSettings.value.tableActionsVisible = 3
    await flushPromises()
    expect(inline(w)).toEqual(['查看', '编辑', '复制'])
    expect(w.find('.qw-table-more').exists()).toBe(false)
  })

  it('orders danger buttons last, so they move into More first', async () => {
    const w = mountTable([{ label: '删除', type: 'danger' }, { label: '编辑' }, { label: '复制' }])
    await flushPromises()
    expect(inline(w)).toEqual(['编辑', '复制'])
    const items = await openMore(w)
    expect(labels(items)).toEqual(['删除'])
    expect(items[0]!.classList.contains('qw-table-more__danger')).toBe(true)
  })

  it('does not count buttons whose permission the user lacks', async () => {
    useAuthStore().me = { perms: ['demo.x.modify'] } as unknown as MePayload
    const w = mountTable([
      { label: '编辑', perm: 'demo.x.modify' },
      { label: '分配', perm: 'demo.x.assign' },
      { label: '删除', type: 'danger', perm: 'demo.x.remove' },
    ])
    await flushPromises()
    expect(inline(w)).toEqual(['编辑'])
    expect(w.find('.qw-table-more').exists()).toBe(false)
  })

  it('runs the hidden button handlers with the click event; disabled and loading stay off', async () => {
    const remove = vi.fn<(e: MouseEvent) => void>()
    const once = vi.fn<(e: MouseEvent) => void>()
    const blocked = vi.fn<(e: MouseEvent) => void>()
    const w = mountTable([
      { label: '编辑' },
      { label: '复制' },
      { label: '删除', type: 'danger', onClick: remove },
      { label: '停用', disabled: true, onClick: blocked },
      { label: '同步', loading: true, onClick: blocked },
      { label: '导出', onClickOnce: once },
    ])
    await flushPromises()
    const items = await openMore(w)
    expect(labels(items)).toEqual(['停用', '同步', '导出', '删除'])
    expect(items[0]!.getAttribute('aria-disabled')).toBe('true')
    expect(items[1]!.getAttribute('aria-disabled')).toBe('true')
    expect(items[1]!.querySelector('.is-loading')).not.toBeNull()
    items[3]!.click()
    items[2]!.click()
    items[0]!.click()
    items[1]!.click()
    await flushPromises()
    expect(remove).toHaveBeenCalledOnce()
    expect(remove.mock.calls[0]![0]).toBeInstanceOf(MouseEvent)
    expect(once).toHaveBeenCalledOnce()
    expect(blocked).not.toHaveBeenCalled()
  })

  it('first paints an estimate from the labels and Element Plus link-button metrics', async () => {
    const two = mountTable([{ label: '编辑' }, { label: '删除', type: 'danger' }])
    const none = mountTable([], { data: [] })
    await nextFrame()
    // happy-dom lays nothing out (scrollWidth 0): the estimate stays. A link button = its text (2 CJK
    // characters × 14px) + 2px padding and 1px border a side; 12px between the buttons
    expect(width(two)).toBe(2 * (2 * 14 + 6) + 12 + CELL)
    expect(width(none)).toBe(80)
  })

  it('sizes the column from the measured actions unless actions-width is given', async () => {
    fakeLayout(50)
    const two = mountTable([{ label: '编辑' }, { label: '删除', type: 'danger' }])
    const four = mountTable([
      { label: '编辑' },
      { label: '复制' },
      { label: '导出' },
      { label: '删除' },
    ])
    const explicit = mountTable([{ label: '编辑' }, { label: '复制' }, { label: '导出' }], {
      actionsWidth: 320,
    })
    await nextFrame()
    expect(width(two)).toBe(2 * 50 + CELL)
    // two inline buttons + the More trigger
    expect(width(four)).toBe(3 * 50 + CELL)
    expect(width(explicit)).toBe(320)
  })

  it('never measures narrower than 80px', async () => {
    fakeLayout(20)
    const w = mountTable([{ label: '编辑' }])
    await nextFrame()
    expect(width(w)).toBe(80)
  })

  it('measures other children whole: icon buttons in a span and a popconfirm-wrapped button', async () => {
    fakeLayout(40)
    const confirmed = vi.fn<() => void>()
    const w = mountSlot(() => [
      h('span', { class: 'move' }, [
        h(IconButton, { icon: 'lucide:arrow-up', label: 'up' }),
        h(IconButton, { icon: 'lucide:arrow-down', label: 'down' }),
      ]),
      button({ label: '编辑' }),
      h(
        ElPopconfirm as Component,
        { title: 'sure?', onConfirm: confirmed },
        { reference: () => h(ElButton as Component, { link: '', type: 'danger' }, () => '删除') },
      ),
      button({ label: '复制' }),
      button({ label: '导出' }),
    ])
    await nextFrame()
    const cell = w.find('.el-table__body .qw-table-actions')
    // the popconfirm's button is not split: it stays inline next to the span, the More holds the 3rd button
    expect(cell.findAll('.icon-button')).toHaveLength(2)
    expect(cell.text()).toContain('删除')
    expect(inline(w)).toEqual(['编辑', '删除', '复制'])
    expect(labels(await openMore(w))).toEqual(['导出'])
    // 2 icon buttons + 编辑 + 删除 + 复制 + More = 6 buttons measured
    expect(width(w)).toBe(6 * 40 + CELL)
  })

  it('measures again when a permission arrives later', async () => {
    fakeLayout(50)
    useAuthStore().me = { perms: ['demo.x.modify'] } as unknown as MePayload
    const w = mountTable([
      { label: '编辑', perm: 'demo.x.modify' },
      { label: '删除', type: 'danger', perm: 'demo.x.remove' },
    ])
    await nextFrame()
    expect(width(w)).toBe(50 + CELL)
    useAuthStore().me = { perms: ['demo.x.modify', 'demo.x.remove'] } as unknown as MePayload
    await nextFrame()
    expect(inline(w)).toEqual(['编辑', '删除'])
    expect(width(w)).toBe(2 * 50 + CELL)
  })

  it('takes the widest row', async () => {
    fakeLayout(50)
    const data = ref([{ id: 1, name: 'a', extra: false }])
    const w = mount(
      defineComponent({
        render: () =>
          h(
            QwTable as Component,
            { tableId: TABLE, columns, data: data.value },
            {
              actions: ({ row }: { row: { extra: boolean } }) => [
                button({ label: '编辑' }),
                button({ label: '复制' }),
                row.extra ? button({ label: '导出全部' }) : null,
              ],
            },
          ),
      }),
      { global },
    )
    wrappers.push(w)
    await nextFrame()
    expect(width(w)).toBe(2 * 50 + CELL)
    data.value = [...data.value, { id: 2, name: 'b', extra: true }]
    await nextFrame()
    expect(width(w)).toBe(3 * 50 + CELL)
  })

  it('runs a generated page delete from More through its confirm', async () => {
    const calls = mockApi({
      'GET /iam/profile/prefs/table.demo.topic': ok({ value: null }),
      'GET /demo/topics': ok([
        {
          id: 7,
          parentId: null,
          title: 'Leaf',
          sortNo: 0,
          enabled: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          children: [],
        },
      ]),
      'DELETE /demo/topics/7': ok(null),
    })
    const ask = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const w = mount(TopicPage, { global, attachTo: document.body })
    wrappers.push(w)
    await flushPromises()
    const t = i18n.global.t
    expect(inline(w)).toEqual([t('crud.action.edit'), t('crud.action.addChild')])
    const items = await openMore(w)
    expect(labels(items)).toEqual([t('crud.action.delete')])
    items[0]!.click()
    await flushPromises()
    expect(ask).toHaveBeenCalledOnce()
    expect(calls.filter((c) => c.method === 'delete').map((c) => c.url)).toEqual(['/demo/topics/7'])
  })
})
