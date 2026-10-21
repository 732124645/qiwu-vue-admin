<script setup lang="ts" generic="T extends object">
import {
  Comment,
  Fragment,
  Text,
  computed,
  h,
  isVNode,
  onBeforeUnmount,
  ref,
  watch,
  type VNode,
} from 'vue'
import { useI18n } from 'vue-i18n'
import { useTablePrefs, type QwColumn } from '@/core/composables/use-table-prefs'
import { Icon } from '@/core/icons'
import { vPerm } from '@/core/permission'
import { appSettings } from '@/core/stores/app'
import { useAuthStore } from '@/core/stores/auth'
import EmptyState from './EmptyState.vue'

/**
 * el-table from a column array (see docs/design-notes.md#crud-kit): the `columns` in the user's order and visibility
 * (`useTablePrefs(tableId)`, edited in `TableToolbar`); a cell shows `row[prop]` unless the page gives
 * `#cell-<prop>="{ row }"`. `#actions="{ row }"` adds the fixed right actions column (not in the settings),
 * `selection` a checkbox column (`selectable(row)` false: that row's box is disabled). Other el-table
 * props and events (`@sort-change`, `@selection-change`) pass through to the el-table. Without rows it
 * shows `#empty`, by default an `EmptyState`: "no data", or with `filtered` (`useCrudList().filtered`)
 * "no match" and a clear-filters button (`@reset-filters`).
 *
 * Row actions: at most `actionsVisible` buttons stay inline (default: the page setting
 * `appSettings.tableActionsVisible`, 2), the rest go into a "More" dropdown (hover or keyboard); danger
 * buttons always come last, so they are the first to move there. Only direct `el-button`s are split:
 * anything else (a button inside a popconfirm, icon buttons, a page's own dropdown) stays inline as it is.
 * Without an explicit `actionsWidth` the column is as wide as the widest row's rendered actions measure
 * (an estimate from the labels until the first measurement), so a cell never clips a button.
 */
defineOptions({ name: 'QwTable', inheritAttrs: false })
const {
  tableId,
  columns,
  data,
  loading = false,
  rowKey = 'id',
  selection = false,
  selectable,
  filtered = false,
  actionsWidth,
  actionsVisible,
} = defineProps<{
  /** `<domain>.<biz>`, e.g. `iam.position`: the settings key `table.<tableId>` */
  tableId: string
  columns: QwColumn[]
  data: T[]
  loading?: boolean
  rowKey?: string
  selection?: boolean
  /** rows the selection may take (default all), e.g. not the protected ones a batch action would refuse */
  selectable?: (row: T) => boolean
  /** the rows were loaded with a filter set: the empty state offers to clear it */
  filtered?: boolean
  /** fixed width of the actions column; default: estimated from the inline buttons */
  actionsWidth?: number | string
  /** row buttons shown inline before the "More" dropdown; default `appSettings.tableActionsVisible` */
  actionsVisible?: number
}>()
const emit = defineEmits<{ resetFilters: [] }>()
const slots = defineSlots<
  { [slot: `cell-${string}`]: (scope: { row: T }) => unknown } & {
    actions?: (scope: { row: T }) => unknown
    empty?: () => unknown
  }
>()
const { t } = useI18n()
const { visibleColumns } = useTablePrefs(tableId, () => columns)
const hasLoaded = ref(false)
watch(
  () => loading,
  (busy, wasBusy) => {
    if (wasBusy && !busy) hasLoaded.value = true
  },
  { flush: 'sync' },
)
const columnWidth = (width: number | string) => `${Number.parseInt(String(width), 10)}px`

const auth = useAuthStore()
// Element Plus link-button metrics at the default size (14px, semibold), for the first paint only: a link
// button is its text + 2px padding + 1px transparent border a side; an icon 14px + 6px margin
const WIDE_CHAR = 14
const NARROW_CHAR = 8
const ICON = 20
const ICON_BUTTON = 32
const LINK_PAD = 6
const BUTTON_PAD = 32
const GAP = 12
// the cell's padding (element.css `.el-table .cell`: 0 16px) and rounding slack
const CELL_PAD = 32 + 2
const MIN_ACTIONS_WIDTH = 80

/** 模板里不带值的布尔属性（如 `link`、`disabled`）在 VNode props 中是空字符串，也算开启。 */
const flag = (v: unknown) => v === '' || Boolean(v)
const isNamed = (node: VNode, name: string) =>
  typeof node.type === 'object' && (node.type as { name?: string }).name === name
const isButton = (node: VNode) => isNamed(node, 'ElButton')
const isDanger = (node: VNode) => node.props?.type === 'danger'
const isOff = (node: VNode) => flag(node.props?.disabled) || flag(node.props?.loading)

/**
 * 展开操作插槽的顶层节点：拆开片段（`<template v-if>`、`v-for`），去掉注释（为假的 `v-if`）和空白文本；
 * `v-perm` 不通过的节点也去掉——指令本身只会隐藏它，若保留则会占用行内名额或在“更多”里留下空位。
 */
function flatten(children: unknown, out: VNode[] = []): VNode[] {
  if (Array.isArray(children)) for (const c of children) flatten(c, out)
  else if (isVNode(children)) {
    if (children.type === Fragment) flatten(children.children, out)
    else if (children.type === Comment) return out
    else if (children.type === Text && !String(children.children).trim()) return out
    else if (!children.dirs?.some((d) => d.dir === vPerm && !auth.hasPerm(d.value)))
      out.push(children)
  }
  return out
}

/** 节点的内容：元素的子节点，或组件的默认插槽（没有时取 `#reference`，如 el-popconfirm 包着的按钮）。 */
function contentOf(children: unknown): unknown {
  if (typeof children === 'function') return children()
  if (children && typeof children === 'object' && !Array.isArray(children) && !isVNode(children)) {
    const slots = children as { default?: () => unknown; reference?: () => unknown }
    return (slots.default ?? slots.reference)?.()
  }
  return children
}

/** 估算内容的文字和图标宽度：中日韩等全角字符按整字宽，其余按半宽。 */
function contentWidth(c: unknown): number {
  if (typeof c === 'string' || typeof c === 'number')
    return [...String(c).trim()].reduce(
      (w, ch) => w + ((ch.codePointAt(0) ?? 0) >= 0x2e80 ? WIDE_CHAR : NARROW_CHAR),
      0,
    )
  if (Array.isArray(c)) return c.reduce((w: number, x) => w + contentWidth(x), 0)
  if (!isVNode(c) || c.type === Comment) return 0
  if (isNamed(c, 'ElIcon')) return ICON
  if (isNamed(c, 'IconButton')) return ICON_BUTTON
  if (isButton(c)) return nodeWidth(c)
  return contentWidth(contentOf(c.children))
}

/** 单个行内项的估算宽度：链接按钮只有很小的内边距和透明边框，普通按钮有左右内边距和边框。 */
function nodeWidth(node: VNode): number {
  if (!isButton(node)) return contentWidth(node)
  const pad = flag(node.props?.link) || flag(node.props?.text) ? LINK_PAD : BUTTON_PAD
  return contentWidth(contentOf(node.children)) + pad
}

const inlineCount = computed(() => {
  const n = actionsVisible ?? appSettings.value.tableActionsVisible
  // `Infinity`: never a "More" (a page with its own dropdown in the slot)
  return typeof n === 'number' && !Number.isNaN(n) ? Math.max(0, Math.floor(n)) : 2
})

/**
 * 一行的操作项（保持插槽顺序）：按钮按“危险操作排最后”排序后依次填入按钮位置，最多 `inlineCount` 个；
 * 下一个按钮位置放溢出部分（数组，即“更多”下拉中的按钮）。其他节点（页面自带的下拉、标签）原位保留且不计数。
 */
function actionItems(row: T): (VNode | VNode[])[] {
  const nodes = flatten(slots.actions?.({ row }))
  const buttons = nodes.filter(isButton)
  const ordered = [...buttons].sort((a, b) => Number(isDanger(a)) - Number(isDanger(b)))
  const shown = buttons.length > inlineCount.value ? ordered.slice(0, inlineCount.value) : ordered
  const more = ordered.slice(shown.length)
  const items: (VNode | VNode[])[] = []
  let i = 0
  for (const node of nodes) {
    if (!isButton(node)) {
      items.push(node)
      continue
    }
    if (i < shown.length) items.push(shown[i]!)
    else if (i === shown.length) items.push(more)
    i++
  }
  return items
}

/** 首次绘制用的估算列宽：所有行（含树形子行）中行内项最宽的一行，加“更多”触发按钮和单元格内边距。 */
const estimatedActionsWidth = computed(() => {
  const more = contentWidth(t('crud.action.more')) + ICON + LINK_PAD
  let widest = 0
  const visit = (rows: readonly unknown[]) => {
    for (const row of rows) {
      const items = actionItems(row as T)
      const w = items.reduce((s: number, it) => s + (Array.isArray(it) ? more : nodeWidth(it)), 0)
      widest = Math.max(widest, w + GAP * Math.max(0, items.length - 1))
      const kids = (row as { children?: unknown }).children
      if (Array.isArray(kids)) visit(kids)
    }
  }
  if (slots.actions) visit(data)
  return Math.max(MIN_ACTIONS_WIDTH, Math.ceil(widest + CELL_PAD))
})

/*
 * 实测列宽：每行的操作项包在一个按内容撑开的容器里，渲染后读它的 scrollWidth，取所有行的最大值。
 * 估算只管首帧——加载转圈、图标按钮、popconfirm 包着的按钮、异步到达的权限、条件插槽都以实测为准。
 * 单元格每次重渲染都会重新调用 ref 函数，内容尺寸变化由 ResizeObserver 通知；测量合并到下一帧，
 * 最大值变化不到 1px 不更新。容器宽度只取决于内容、不取决于列宽，所以改列宽不会再触发测量（无循环）。
 */
const actionCells = new Set<HTMLElement>()
const measured = ref<number | null>(null)
let frame = 0
const resizes =
  typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => scheduleMeasure())

function scheduleMeasure() {
  if (!frame) frame = requestAnimationFrame(measure)
}

function measure() {
  frame = 0
  let widest = 0
  for (const el of actionCells) {
    // 已卸载的行：它的祖先链在被移除的节点处断开，找不到表格
    if (!el.closest('.el-table')) {
      actionCells.delete(el)
      resizes?.unobserve(el)
    } else widest = Math.max(widest, el.scrollWidth)
  }
  if (!actionCells.size) measured.value = null
  // 全为 0：表格不可见（隐藏的标签页、keep-alive），保留上次的值，显示后 ResizeObserver 会再通知
  else if (widest > 0 && Math.abs(widest - (measured.value ?? 0)) >= 1) measured.value = widest
}

/** 单元格操作容器的 ref：挂载和每次重渲染时登记并安排测量。 */
function trackActions(el: unknown) {
  if (!(el instanceof HTMLElement)) return
  if (!actionCells.has(el)) {
    actionCells.add(el)
    resizes?.observe(el)
  }
  scheduleMeasure()
}

onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  resizes?.disconnect()
  actionCells.clear()
})

const actionsColumnWidth = computed(
  () =>
    actionsWidth ??
    (measured.value == null
      ? estimatedActionsWidth.value
      : Math.max(MIN_ACTIONS_WIDTH, Math.ceil(measured.value + CELL_PAD))),
)
// 骨架屏不调用行插槽（行数据可能尚未就绪），自动列宽时用一个常见宽度占位
const skeletonActionsWidth = computed(() => actionsWidth ?? 140)

/**
 * “更多”中的一项执行按钮原有的点击处理（`@click` 和 `@click.once` 编译出的 `onClickOnce`），传入真实的
 * 点击事件；禁用或加载中的按钮不执行（下拉项本身也已禁用）。
 */
function runAction(node: VNode, event: MouseEvent) {
  if (isOff(node)) return
  for (const fn of [node.props?.onClick, node.props?.onClickOnce].flat())
    if (typeof fn === 'function') fn(event)
}
/** 按钮的文字和图标，作为下拉项的内容。 */
function labelOf(node: VNode) {
  const content = contentOf(node.children)
  return h(Fragment, null, Array.isArray(content) ? content : [content])
}
</script>

<template>
  <div v-if="loading && !hasLoaded" class="qw-table-skeleton" aria-busy="true">
    <p role="status">{{ t('crud.loading') }}</p>
    <div class="qw-table-skeleton__header" aria-hidden="true">
      <span v-if="selection" class="qw-table-skeleton__cell" style="flex: 0 0 48px" />
      <span
        v-for="c in visibleColumns"
        :key="c.prop"
        class="qw-table-skeleton__cell"
        :style="{
          flex: c.width ? `0 0 ${columnWidth(c.width)}` : `1 0 ${columnWidth(c.minWidth ?? 80)}`,
        }"
      >
        {{ c.literal ? c.label : t(c.label) }}
      </span>
      <span
        v-if="$slots.actions"
        class="qw-table-skeleton__cell"
        :style="{ flex: `0 0 ${columnWidth(skeletonActionsWidth)}` }"
      >
        {{ t('crud.action.operations') }}
      </span>
    </div>
    <el-skeleton :count="5" aria-hidden="true" inert>
      <template #template>
        <div class="qw-table-skeleton__row">
          <span v-if="selection" class="qw-table-skeleton__cell" style="flex: 0 0 48px">
            <el-skeleton-item />
          </span>
          <span
            v-for="c in visibleColumns"
            :key="c.prop"
            class="qw-table-skeleton__cell"
            :data-column="c.prop"
            :style="{
              flex: c.width
                ? `0 0 ${columnWidth(c.width)}`
                : `1 0 ${columnWidth(c.minWidth ?? 80)}`,
            }"
          >
            <el-skeleton-item />
          </span>
          <span
            v-if="$slots.actions"
            class="qw-table-skeleton__cell"
            :style="{ flex: `0 0 ${columnWidth(skeletonActionsWidth)}` }"
          >
            <el-skeleton-item />
          </span>
        </div>
      </template>
    </el-skeleton>
  </div>
  <el-table
    v-else
    v-bind="$attrs"
    v-loading="loading"
    :element-loading-text="t('crud.loading')"
    :data="data"
    :row-key="rowKey"
  >
    <el-table-column v-if="selection" type="selection" width="48" :selectable />
    <el-table-column
      v-for="c in visibleColumns"
      :key="c.prop"
      :prop="c.prop"
      :label="c.literal ? c.label : t(c.label)"
      :width="c.width"
      :min-width="c.minWidth"
      :sortable="c.sortable ? 'custom' : false"
      :align="c.align"
      :fixed="c.fixed"
      :show-overflow-tooltip="c.showOverflowTooltip"
    >
      <template v-if="$slots[`cell-${c.prop}`]" #default="{ row }">
        <slot :name="`cell-${c.prop}`" :row="row" />
      </template>
    </el-table-column>
    <el-table-column
      v-if="$slots.actions"
      :label="t('crud.action.operations')"
      :width="actionsColumnWidth"
      fixed="right"
    >
      <template #default="{ row }">
        <div :ref="trackActions" class="qw-table-actions">
          <template v-for="(item, i) in actionItems(row)" :key="i">
            <!-- hover only: a click on the trigger keeps the menu open; Enter / Space / ↓ open it too -->
            <el-dropdown v-if="Array.isArray(item)" class="qw-table-more" :persistent="false">
              <el-button link type="primary">
                {{ t('crud.action.more') }}
                <el-icon class="el-icon--right"><Icon icon="lucide:chevron-down" /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item
                    v-for="(b, n) in item"
                    :key="n"
                    :disabled="isOff(b)"
                    :class="{ 'qw-table-more__danger': isDanger(b) }"
                    @click="(e: MouseEvent) => runAction(b, e)"
                  >
                    <el-icon v-if="flag(b.props?.loading)" class="is-loading">
                      <Icon icon="lucide:loader-circle" />
                    </el-icon>
                    <component :is="labelOf(b)" />
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <component :is="item" v-else />
          </template>
        </div>
      </template>
    </el-table-column>
    <template #empty>
      <slot name="empty">
        <EmptyState
          v-if="filtered"
          :title="t('common.empty.noMatch')"
          :description="t('common.empty.noMatchHint')"
        >
          <el-button @click="emit('resetFilters')">{{ t('crud.action.resetFilters') }}</el-button>
        </EmptyState>
        <EmptyState v-else />
      </slot>
    </template>
  </el-table>
</template>

<style>
/* as wide as its content, whatever the column's width: what the column width is measured from */
.qw-table-actions {
  display: inline-flex;
  align-items: center;
  width: max-content;
  white-space: nowrap;
  vertical-align: middle;
}
/* the "More" dropdown sits after the inline link buttons with their gap (Element Plus spaces only button + button) */
.qw-table-more {
  margin-left: 12px;
}
.qw-table-more:first-child {
  margin-left: 0;
}
/* above Element Plus's `.el-dropdown-menu__item:not(.is-disabled):hover / :focus`: red in every state */
:root .el-dropdown-menu__item.qw-table-more__danger:not(.is-disabled) {
  color: var(--qw-danger);
}
</style>
