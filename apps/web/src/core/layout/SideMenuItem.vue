<script setup lang="ts">
import { computed } from 'vue'
import type { MenuNode } from '@qiwu/shared'
import { localized } from '@/core/i18n'
import { Icon } from '@/core/icons'
import { joinPath } from '@/core/router/build-routes'
import TodoBadge from './TodoBadge.vue'

/**
 * `flat`: a group renders as a plain item (mix layout's top bar; SideMenu opens its first page). The
 * approval center's 我的待办 (seeded route name `wf-todo`) carries the pending-task count.
 */
const {
  node,
  base = '',
  flat = false,
} = defineProps<{
  node: MenuNode
  base?: string
  flat?: boolean
}>()

const path = computed(() => joinPath(base, node.routePath))
/** hidden rows (`visible=0`) and groups without anything to show stay out of the menu */
const children = computed(() => node.children.filter(shown))
const title = computed(() => localized(node.nameI18n, node.name))
</script>

<script lang="ts">
import type { Router } from 'vue-router'

export const shown = (n: MenuNode): boolean =>
  n.visible && (n.kind === 'page' || n.children.some(shown))

export const collapses = (n: MenuNode): boolean =>
  n.kind === 'group' && !n.alwaysShow && n.children.filter(shown).length === 1

/** Path of the first page shown under `n` (itself when a page); external links are skipped. */
export function firstPage(n: MenuNode, base = ''): string | undefined {
  const path = joinPath(base, n.routePath)
  if (n.kind === 'page') return n.linkType === 'external' ? undefined : path
  for (const c of n.children.filter(shown)) {
    const hit = firstPage(c, path)
    if (hit) return hit
  }
}

/** Menu item target: external URLs open in a new tab, everything else is a route. */
export function openMenu(router: Router, to: string) {
  if (/^https?:\/\//i.test(to)) window.open(to, '_blank', 'noopener,noreferrer')
  else void router.push(to)
}
</script>

<template>
  <SideMenuItem
    v-if="!flat && collapses(node)"
    :node="{ ...children[0]!, icon: children[0]!.icon || node.icon }"
    :base="path"
  />
  <el-sub-menu v-else-if="node.kind === 'group' && !flat" :index="path">
    <template #title>
      <el-icon v-if="node.icon"><Icon :icon="node.icon" /></el-icon>
      <span>{{ title }}</span>
    </template>
    <SideMenuItem v-for="c in children" :key="c.id" :node="c" :base="path" />
  </el-sub-menu>
  <!-- external links: the index is the URL, SideMenu opens it in a new tab -->
  <el-menu-item v-else :index="node.linkType === 'external' ? (node.linkUrl ?? '') : path">
    <el-icon v-if="node.icon"><Icon :icon="node.icon" /></el-icon>
    <template #title>
      <span>{{ title }}</span>
      <TodoBadge v-if="node.routeName === 'wf-todo'" />
      <el-icon v-if="node.linkType === 'external'" class="side-menu__ext">
        <Icon icon="lucide:arrow-up-right" />
      </el-icon>
    </template>
  </el-menu-item>
</template>
