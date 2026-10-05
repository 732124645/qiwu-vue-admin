<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import type { MenuNode } from '@qiwu/shared'
import { joinPath } from '@/core/router/build-routes'
import { useMenuStore } from '@/core/stores/menu'
import SideMenuItem, { collapses, firstPage, openMenu, shown } from './SideMenuItem.vue'

/**
 * The granted menu tree as an el-menu: vertical in the aside/drawer, horizontal in the top layout.
 * `nodes`/`base`: a subtree (mix layout aside). `roots`: top-level entries only, a group opens its
 * first page (mix layout top bar).
 */
const {
  collapsed = false,
  horizontal = false,
  roots = false,
  nodes,
  base = '',
} = defineProps<{
  collapsed?: boolean
  horizontal?: boolean
  roots?: boolean
  nodes?: MenuNode[]
  base?: string
}>()

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const menu = useMenuStore()
const items = computed(() => (nodes ?? menu.tree).filter(shown))
const menuRef = ref<{ open: (index: string) => void } | null>(null)
const openeds = computed(() =>
  menu
    .trail(route.meta.menuId ?? 0)
    .filter(
      ({ node, path }) => node.kind === 'group' && shown(node) && path !== base && !collapses(node),
    )
    .map(({ path }) => path),
)
// default-openeds applies on mount; open() also handles later navigation and a folded menu expanding.
watch(
  [openeds, () => collapsed],
  async ([paths, folded]) => {
    if (!horizontal && !folded) {
      await nextTick() // el-menu recreates its items after leaving 64px collapse mode
      paths.forEach((path) => menuRef.value?.open(path))
    }
  },
  { flush: 'post' },
)
/** roots: the top-level entry the current page lives under */
const active = computed(() =>
  roots ? (menu.trail(route.meta.menuId ?? 0)[0]?.path ?? route.path) : route.path,
)

function select(index: string) {
  const group = roots && items.value.find((n) => joinPath(base, n.routePath) === index)
  const to = group ? firstPage(group, base) : index
  if (to) openMenu(router, to)
}
</script>

<template>
  <nav
    class="side-menu"
    :class="{ 'side-menu--horizontal': horizontal }"
    :aria-label="t(horizontal ? 'layout.topMenu' : 'common.layout.sideMenu')"
  >
    <el-menu
      ref="menuRef"
      :default-active="active"
      :default-openeds="horizontal ? [] : openeds"
      :mode="horizontal ? 'horizontal' : 'vertical'"
      :collapse="!horizontal && collapsed"
      :collapse-transition="false"
      class="side-menu__menu"
      @select="select"
    >
      <SideMenuItem v-for="n in items" :key="n.id" :node="n" :base :flat="roots" />
    </el-menu>
  </nav>
</template>

<style scoped>
/* the el-menu itself is styled in styles/element.css (navy side bar, dark top bar) */
.side-menu--horizontal {
  flex: 1;
  align-self: stretch;
  min-width: 0;
}
:deep(.side-menu__ext) {
  margin-left: 4px;
  font-size: 12px;
  opacity: 0.7;
}
</style>
