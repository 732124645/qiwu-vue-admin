<script setup lang="ts" generic="T extends { id: number; children?: T[] }">
import { computed, ref, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useStorage } from '@vueuse/core'
import type { TreeInstance } from 'element-plus'
import { Icon } from '@/core/icons'
import IconButton from './IconButton.vue'

/**
 * A tree beside a page's content (see docs/design-notes.md#layering), e.g. the departments left of the user list: the page content
 * goes in the default slot. `v-model` = the selected node's id (`null` = none; clicking the selected node
 * again clears it); the box above filters the tree by `label`. Drag the edge (or focus it, ← / →) to
 * resize, collapse to a slim rail; both are kept per `storageKey` in this browser.
 */
defineOptions({ name: 'TreePanel' })
const {
  data,
  label,
  title,
  storageKey,
  loading = false,
} = defineProps<{
  data: T[]
  /** a node's text, e.g. `(d) => tx(d.name)` for seeded names */
  label: (node: T) => string
  title: string
  storageKey: string
  loading?: boolean
}>()
const model = defineModel<number | null>({ default: null })
defineSlots<{ default?: () => unknown }>()
const { t } = useI18n()

const MIN = 200
const MAX = 480
const STEP = 16
const clamp = (w: number) => Math.min(MAX, Math.max(MIN, Math.round(w)))
const prefs = useStorage(
  `qw.tree-panel.${storageKey}`,
  { width: 240, collapsed: false },
  undefined,
  { mergeDefaults: true },
)
const width = computed(() => clamp(prefs.value.width))
const resizeBy = (dx: number) => (prefs.value.width = clamp(width.value + dx))

function startResize(e: PointerEvent) {
  e.preventDefault() // no text selection while dragging
  const handle = e.currentTarget as HTMLElement
  const [x0, w0] = [e.clientX, width.value]
  handle.setPointerCapture?.(e.pointerId)
  const move = (m: PointerEvent) => (prefs.value.width = clamp(w0 + m.clientX - x0))
  const end = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', end)
    handle.removeEventListener('pointercancel', end)
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', end)
  handle.addEventListener('pointercancel', end)
}

const tree = useTemplateRef<TreeInstance>('tree')
const filter = ref('')
const treeProps = { label: (d: unknown) => label(d as T), children: 'children' }
const matches = (q: string, d: unknown) =>
  label(d as T)
    .toLowerCase()
    .includes(q.toLowerCase())
// after (re)loads and from outside (the page's reset): the highlight and the filter follow
watch(
  [() => data, model, filter, () => prefs.value.collapsed],
  () => {
    tree.value?.setCurrentKey(model.value ?? undefined)
    tree.value?.filter(filter.value.trim())
  },
  { flush: 'post' },
)
const onNodeClick = (node: T) => (model.value = model.value === node.id ? null : node.id)
</script>

<template>
  <div class="tree-panel">
    <aside
      v-if="!prefs.collapsed"
      class="tree-panel__aside"
      :style="{ width: `${width}px` }"
      :aria-label="title"
    >
      <div class="tree-panel__card">
        <div class="tree-panel__head">
          <span class="tree-panel__title">{{ title }}</span>
          <IconButton
            icon="lucide:panel-left-close"
            :label="t('picker.tree.collapse', { title })"
            @click="prefs.collapsed = true"
          />
        </div>
        <el-input
          v-model="filter"
          class="tree-panel__filter"
          clearable
          :placeholder="t('picker.tree.filter')"
          :aria-label="t('picker.tree.filter')"
        >
          <template #prefix><Icon icon="lucide:search" /></template>
        </el-input>
        <el-tree
          ref="tree"
          v-loading="loading"
          class="tree-panel__tree"
          :data
          node-key="id"
          :props="treeProps"
          highlight-current
          default-expand-all
          :expand-on-click-node="false"
          :filter-node-method="matches"
          :empty-text="t(filter ? 'common.empty.noMatch' : 'common.empty.title')"
          :aria-label="title"
          @node-click="onNodeClick"
        />
      </div>
      <div
        class="tree-panel__resizer"
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        :aria-valuenow="width"
        :aria-valuemin="MIN"
        :aria-valuemax="MAX"
        :aria-label="t('picker.tree.resize', { title })"
        @pointerdown="startResize"
        @keydown.left.prevent="resizeBy(-STEP)"
        @keydown.right.prevent="resizeBy(STEP)"
      />
    </aside>
    <aside v-else class="tree-panel__rail" :aria-label="title">
      <IconButton
        icon="lucide:panel-left-open"
        :label="t('picker.tree.expand', { title })"
        @click="prefs.collapsed = false"
      />
    </aside>
    <div class="tree-panel__main"><slot /></div>
  </div>
</template>

<style scoped>
.tree-panel {
  display: flex;
  gap: 16px;
  align-items: stretch;
}
/* the content sets the height; the tree scrolls inside it (360px at least) */
.tree-panel__aside {
  position: relative;
  flex: none;
  min-height: 360px;
}
.tree-panel__card,
.tree-panel__rail {
  box-sizing: border-box;
  background: var(--qw-surface);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius);
  box-shadow: var(--qw-shadow-1);
}
.tree-panel__card {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 8px 8px 16px;
}
/* in a dialog the panel sits on the dialog's surface: no card shadow */
.el-dialog .tree-panel__card,
.el-dialog .tree-panel__rail {
  box-shadow: none;
}
.tree-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 32px;
}
.tree-panel__title {
  overflow: hidden;
  font-size: 14px;
  font-weight: 600;
  color: var(--qw-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tree-panel__filter {
  width: auto;
  margin-right: 8px;
}
.tree-panel__tree {
  flex: 1;
  min-height: 0;
  padding-right: 8px;
  overflow: auto;
}
/* an 8px grab area in the gap, a 2px line in the brand color while hovered, focused or dragged */
.tree-panel__resizer {
  position: absolute;
  top: 0;
  right: -12px;
  bottom: 0;
  width: 8px;
  cursor: col-resize;
  touch-action: none;
  border-radius: 4px;
}
.tree-panel__resizer::after {
  position: absolute;
  top: 12px;
  bottom: 12px;
  left: 3px;
  width: 2px;
  content: '';
  border-radius: 1px;
  transition: background-color 0.15s;
}
.tree-panel__resizer:hover::after,
.tree-panel__resizer:active::after,
.tree-panel__resizer:focus-visible::after {
  background: var(--qw-brand);
}
.tree-panel__resizer:focus-visible {
  outline-offset: 0;
}
.tree-panel__rail {
  flex: none;
  align-self: flex-start;
  padding: 4px;
}
.tree-panel__main {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}
</style>
