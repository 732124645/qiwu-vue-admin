import { defineComponent, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, type RouteComponent, type RouteRecordRaw } from 'vue-router'
import type { MenuNode } from '@qiwu/shared'

const views = import.meta.glob<RouteComponent>('/src/views/**/*.vue')
/**
 * A view's lazy loader by its path under src/views (`platform/settings/dict/index`): a menu's `component`,
 * a process model's `view_component` (see docs/design-notes.md#workflow); undefined when no such file exists.
 */
export const viewLoader = (component: string) => views[`/src/views/${component}.vue`]
const NotFound = () => import('@/views/error/ErrorView.vue')

/** Route path of the iframe page on screen: AppLayout shows its frame. */
export const shownFrame = ref('')

/**
 * The route component of every iframe page, an empty placeholder: AppLayout renders the frames and keeps
 * a keep-alive page's frame (menu `component_name` in the keep-alive list) in the document, hidden, while
 * other pages show. `<keep-alive>` would park it in a detached node, and a detached iframe drops its
 * document: it would load anew each time it is shown.
 */
const IframePage = defineComponent({
  name: 'IframePage',
  setup() {
    const path = useRoute().matched.at(-1)?.path ?? ''
    // mounted once the previous page has left (out-in transition)
    onMounted(() => (shownFrame.value = path))
    onUnmounted(() => {
      if (shownFrame.value === path) shownFrame.value = ''
    })
    return () => null
  },
})

// absolute routePath as is; relative ones hang under the parent's path
export const joinPath = (base: string, path: string) =>
  path.startsWith('/') ? path : `${base.replace(/\/+$/, '')}/${path}`

/**
 * GET /api/auth/menus tree → flat child routes of the layout (see docs/design-notes.md#layering): `component` resolves through
 * the views glob (`platform/settings/dict/index` → /src/views/…/index.vue), iframe pages use IframePage
 * (AppLayout shows `meta.linkUrl`), external links are not registered, `visible=0`
 * pages are registered with `meta.hidden`.
 */
export function buildRoutes(nodes: MenuNode[], base = ''): RouteRecordRaw[] {
  return nodes.flatMap((n) => {
    const path = joinPath(base, n.routePath)
    const children = buildRoutes(n.children, path)
    if (n.kind !== 'page' || n.linkType === 'external') return children
    const route: RouteRecordRaw = {
      path,
      name: n.routeName || `menu-${n.id}`,
      component:
        n.linkType === 'iframe' ? IframePage : (n.component && viewLoader(n.component)) || NotFound,
      meta: {
        menuId: n.id,
        title: n.name,
        titleI18n: n.nameI18n,
        icon: n.icon,
        hidden: !n.visible,
        keepAlive: n.keepAlive,
        componentName: n.componentName,
        component: n.component,
        linkUrl: n.linkType === 'iframe' ? n.linkUrl : null,
      },
    }
    return [route, ...children]
  })
}
