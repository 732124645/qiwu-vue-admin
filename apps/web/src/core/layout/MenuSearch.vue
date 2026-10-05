<script setup lang="ts">
import { computed, ref, useTemplateRef, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { onKeyStroke } from '@vueuse/core'
import type { MenuNode } from '@qiwu/shared'
import { localized } from '@/core/i18n'
import { Icon } from '@/core/icons'
import { joinPath } from '@/core/router/build-routes'
import { useMenuStore } from '@/core/stores/menu'
import { openMenu, shown } from './SideMenuItem.vue'

/** Header menu search: every page the user sees in the menu, by its localized "Group / Page" name. */
interface Hit {
  value: string
  to: string
}

const { t } = useI18n()
const router = useRouter()
const menu = useMenuStore()
const query = ref('')
const label = computed(() => t('layout.search.placeholder'))
// Element Plus puts role="combobox" on a wrapper div of the input and gives it no name
const root = useTemplateRef<HTMLElement>('root')
watchEffect(() =>
  root.value?.querySelector('[role="combobox"]')?.setAttribute('aria-label', label.value),
)

// ⌘K / Ctrl+K from anywhere focuses the search (the hint in the pill says which)
const mac = /Mac|iPhone|iPad/.test(navigator.userAgent)
onKeyStroke('k', (e) => {
  if (!(mac ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey) return
  e.preventDefault()
  root.value?.querySelector('input')?.focus()
})

function pages(nodes: MenuNode[], base = '', trail: string[] = []): Hit[] {
  return nodes.filter(shown).flatMap((n) => {
    const path = joinPath(base, n.routePath)
    const names = [...trail, localized(n.nameI18n, n.name)]
    if (n.kind !== 'page') return pages(n.children, path, names)
    return [{ value: names.join(' / '), to: n.linkType === 'external' ? (n.linkUrl ?? '') : path }]
  })
}
const hits = computed(() => pages(menu.tree))

function suggest(q: string, done: (hits: Hit[]) => void) {
  const s = q.trim().toLowerCase()
  done(hits.value.filter((h) => h.value.toLowerCase().includes(s)))
}

function go(hit: Record<string, unknown>) {
  query.value = ''
  openMenu(router, (hit as unknown as Hit).to)
}
</script>

<template>
  <span ref="root" class="menu-search">
    <el-autocomplete
      v-model="query"
      :fetch-suggestions="suggest"
      :placeholder="label"
      :aria-label="label"
      :aria-keyshortcuts="mac ? 'Meta+K' : 'Control+K'"
      highlight-first-item
      clearable
      popper-class="menu-search__popper"
      @select="go"
    >
      <template #prefix><Icon icon="lucide:search" /></template>
      <template v-if="!query" #suffix>
        <kbd class="menu-search__kbd" aria-hidden="true">{{ mac ? '⌘K' : 'Ctrl K' }}</kbd>
      </template>
    </el-autocomplete>
  </span>
</template>

<style scoped>
/* the pill itself (el-autocomplete) is styled in styles/element.css; it shrinks first on phones */
.menu-search {
  flex: 0 1 220px;
  min-width: 64px;
}
.menu-search__kbd {
  padding: 0 5px;
  font: 500 11px/18px var(--qw-font);
  color: var(--qw-text-3);
  border: 1px solid var(--qw-border);
  border-radius: 5px;
}
@media (max-width: 767px) {
  .menu-search__kbd {
    display: none;
  }
}
</style>
