import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { MenuNode } from '@qiwu/shared'
import { api } from '@/core/request/http'
import { buildRoutes, joinPath } from '@/core/router/build-routes'

export const flattenMenus = (nodes: MenuNode[]): MenuNode[] =>
  nodes.flatMap((n) => [n, ...flattenMenus(n.children)])

export const useMenuStore = defineStore('menu', () => {
  /** GET /api/auth/menus: granted groups/pages with their ancestors (see docs/design-notes.md#permissions). */
  const tree = ref<MenuNode[]>([])
  const loaded = ref(false)

  /** `<keep-alive :include>`: component names of keep-alive pages. */
  const cacheNames = computed(() =>
    flattenMenus(tree.value)
      .filter((n) => n.kind === 'page' && n.keepAlive && n.componentName)
      .map((n) => n.componentName as string),
  )

  /** Layout child routes generated from the tree (the router guard registers them). */
  const routes = computed(() => buildRoutes(tree.value))
  /** Target of `/`: the first page shown in the side menu. */
  const homePath = computed(() => routes.value.find((r) => !r.meta?.hidden)?.path ?? '')

  /** Menu nodes from the root down to menu `id`, with resolved paths (breadcrumb). */
  function trail(id: number, nodes = tree.value, base = ''): { node: MenuNode; path: string }[] {
    for (const node of nodes) {
      const path = joinPath(base, node.routePath)
      if (node.id === id) return [{ node, path }]
      const rest = trail(id, node.children, path)
      if (rest.length) return [{ node, path }, ...rest]
    }
    return []
  }

  async function load() {
    tree.value = await api.get<MenuNode[]>('/auth/menus')
    loaded.value = true
  }

  function reset() {
    tree.value = []
    loaded.value = false
  }

  return { tree, loaded, cacheNames, routes, homePath, trail, load, reset }
})
