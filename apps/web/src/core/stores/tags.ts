import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useStorage } from '@vueuse/core'
import type { RouteLocationNormalizedLoaded } from 'vue-router'

type Page = Pick<RouteLocationNormalizedLoaded, 'path' | 'fullPath' | 'meta'>
import type { I18nText } from '@qiwu/shared'
import { useMenuStore } from './menu'

/** One open page in TagsView, identified by its route path. */
export interface Tag {
  path: string
  /** with the query: where clicking the tag goes */
  fullPath: string
  title: string
  titleI18n?: I18nText | null
  icon?: string | null
  /** keep-alive cache name (menu `component_name`) */
  cacheName?: string | null
}

export type TagsStyle = 'card' | 'chrome'

export const useTagsStore = defineStore('tags', () => {
  const menu = useMenuStore()
  // localStorage: the open tags survive a reload while `persist` is on
  const persist = useStorage('qw.tags.persist', true)
  const style = useStorage<TagsStyle>('qw.tags.style', 'card')
  const saved = useStorage<Tag[]>('qw.tags.list', [])
  const tags = ref<Tag[]>([])
  watch([tags, persist], () => (saved.value = persist.value ? tags.value : []), { deep: true })

  /** Cache names dropped for a moment so a refreshed page mounts anew. */
  const refreshing = ref<string[]>([])
  /** `<keep-alive :include>`: keep-alive pages that still have an open tag (closing one drops it). */
  const cacheInclude = computed(() => {
    const open = new Set(tags.value.map((t) => t.cacheName))
    return menu.cacheNames.filter((n) => open.has(n) && !refreshing.value.includes(n))
  })

  const affix = (t: Tag) => t.path === menu.homePath
  const toTag = (r: Page): Tag => ({
    path: r.path,
    fullPath: r.fullPath,
    title: r.meta.title ?? r.path,
    titleI18n: r.meta.titleI18n,
    icon: r.meta.icon,
    cacheName: r.meta.componentName,
  })

  /** After sign-in: the home tag first, then saved tags whose pages this user can still open. */
  function init(home: Page, reachable: (t: Tag) => boolean) {
    const kept = persist.value && Array.isArray(saved.value) ? saved.value : []
    tags.value = [
      toTag(home),
      ...kept.filter((t) => typeof t?.path === 'string' && t.path !== home.path && reachable(t)),
    ]
  }

  /** Adds the page, or updates its tag (e.g. a new query). */
  function open(route: Page) {
    const tag = toTag(route)
    const i = tags.value.findIndex((t) => t.path === tag.path)
    if (i < 0) tags.value.push(tag)
    else tags.value[i] = tag
  }

  /** Closes the tags matching `pick` (tag, index); the home tag stays. */
  function close(pick: (t: Tag, i: number) => boolean) {
    tags.value = tags.value.filter((t, i) => affix(t) || !pick(t, i))
  }

  const reset = () => (tags.value = [])

  return { tags, persist, style, refreshing, cacheInclude, affix, init, open, close, reset }
})
