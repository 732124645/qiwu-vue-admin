<script setup lang="ts">
import { nextTick, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { TreeInstance } from 'element-plus'

/**
 * The checkbox tree of the role grants (menus, picked depts): `v-model:link` is the
 * parent-child link switch the role keeps (`menu_link` / `dept_link`). Link on: checking a node checks its
 * subtree and a parent follows its children; `picked()` = the checked plus the half-checked nodes, and the
 * stored ids echo as their leaves (el-tree derives the parents), except a granted parent none of whose
 * descendants is granted (granted with the link off, or its children added later): it echoes half-checked,
 * so a save keeps it without taking its subtree. Link off: every node on its own, picked and echoed
 * exactly as checked. `stored` = the ids to echo (after the data is loaded). Toolbar: the link switch,
 * expand / collapse all, check all / none.
 */
defineOptions({ name: 'IamRoleGrantTree' })

/** A tree node: a menu or a dept (the callers' own types). */
interface Node {
  id: number
  children: Node[]
}

const {
  data,
  stored,
  label,
  treeLabel,
  expanded = [],
} = defineProps<{
  data: Node[]
  stored: number[]
  /** a node's text; called with the caller's node type */
  label: (node: never) => string
  /** the accessible name of the tree */
  treeLabel: string
  /** ids expanded at first (default: none) */
  expanded?: number[]
}>()
const link = defineModel<boolean>('link', { required: true })
defineSlots<{ default?: (scope: { node: never }) => unknown }>()
const { t } = useI18n()
const tree = useTemplateRef<TreeInstance>('tree')

const all = (nodes: Node[]): Node[] => nodes.flatMap((n) => [n, ...all(n.children)])

/**
 * Checks `ids` as the link mode reads them. Link off: exactly. Link on: their leaves (the parents follow),
 * and the granted parents none of whose descendants is granted half-checked (kept by `picked()`, their
 * subtree untouched).
 */
function show(ids: number[]) {
  const t = tree.value
  if (!t) return
  if (!link.value) return t.setCheckedKeys(ids)
  const granted = new Set(ids)
  const nodes = all(data).filter((n) => granted.has(n.id))
  t.setCheckedKeys(nodes.filter((n) => !n.children.length).map((n) => n.id))
  for (const n of nodes)
    if (n.children.length && !all(n.children).some((c) => granted.has(c.id)))
      t.getNode(n.id)?.setChecked('half', false)
}

/** What the role grants: link on = checked + half-checked, link off = checked. */
function picked(): number[] {
  const checked = (tree.value?.getCheckedKeys() ?? []) as number[]
  return link.value
    ? [...checked, ...((tree.value?.getHalfCheckedKeys() ?? []) as number[])]
    : checked
}
defineExpose({ picked })

watch(
  () => [data, stored] as const,
  () => void nextTick(() => show(stored)),
  { flush: 'post', immediate: true },
)

/**
 * Switching the link keeps what a save would store: the picked nodes echo in the new mode (turning it on,
 * a lone ticked parent stays half-checked instead of taking its subtree).
 */
function toggleLink(on: boolean) {
  const before = picked()
  link.value = on
  void nextTick(() => show(before))
}

function expandAll(open: boolean) {
  for (const node of Object.values(tree.value?.store.nodesMap ?? {})) node.expanded = open
}
const checkAll = (on: boolean) => show(on ? all(data).map((n) => n.id) : [])
</script>

<template>
  <div class="grant-tree">
    <div class="grant-tree__bar">
      <el-switch
        :model-value="link"
        :active-text="t('iam.role.tree.link')"
        @update:model-value="toggleLink($event as boolean)"
      />
      <span class="grant-tree__actions">
        <el-button link type="primary" @click="expandAll(true)">
          {{ t('crud.action.expandAll') }}
        </el-button>
        <el-button link type="primary" @click="expandAll(false)">
          {{ t('crud.action.collapseAll') }}
        </el-button>
        <el-button link type="primary" @click="checkAll(true)">
          {{ t('iam.role.tree.checkAll') }}
        </el-button>
        <el-button link type="primary" @click="checkAll(false)">
          {{ t('iam.role.tree.checkNone') }}
        </el-button>
      </span>
    </div>
    <el-scrollbar class="grant-tree__box" max-height="400px">
      <el-tree
        ref="tree"
        :data
        node-key="id"
        show-checkbox
        :check-strictly="!link"
        :default-expanded-keys="expanded"
        :props="{ label: (n: unknown) => label(n as never), children: 'children' }"
        :aria-label="treeLabel"
      >
        <template #default="{ data: node }">
          <slot :node="node as never">{{ label(node as never) }}</slot>
        </template>
      </el-tree>
    </el-scrollbar>
  </div>
</template>

<style scoped>
.grant-tree__bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.grant-tree__actions > .el-button + .el-button {
  margin-left: 12px;
}
.grant-tree__box {
  padding: 4px 0;
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius-sm);
}
</style>
