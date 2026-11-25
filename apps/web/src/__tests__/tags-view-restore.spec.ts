import { afterEach, beforeEach, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import type { MenuNode } from '@qiwu/shared'
import { i18n } from '@/core/i18n'
import TagsView from '@/core/layout/TagsView.vue'
import { LAYOUT } from '@/core/router'
import { useMenuStore } from '@/core/stores/menu'
import { useTagsStore } from '@/core/stores/tags'

let wrapper: VueWrapper | undefined
beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})
afterEach(() => {
  wrapper?.unmount()
  localStorage.clear()
})

it('refreshes persisted titles and cache metadata from current routes without losing query or order', async () => {
  localStorage.setItem(
    'qw.tags.list',
    JSON.stringify([
      {
        path: '/reports',
        fullPath: '/reports?month=10#totals',
        title: 'Old name',
        icon: 'lucide:x',
        cacheName: 'OldReport',
      },
      { path: '/removed', fullPath: '/removed', title: 'Removed page' },
    ]),
  )
  useMenuStore().tree = [
    {
      id: 1,
      kind: 'page',
      routePath: '/home',
      name: 'Home',
      children: [],
      visible: true,
    } as unknown as MenuNode,
  ]
  const page = { template: '<div />' }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/',
        name: LAYOUT,
        component: page,
        children: [
          { path: '/home', component: page, meta: { title: 'Home' } },
          {
            path: '/reports',
            component: page,
            meta: {
              title: 'Current reports',
              icon: 'lucide:chart-line',
              componentName: 'CurrentReport',
            },
          },
        ],
      },
      { path: '/:pathMatch(.*)*', component: page },
    ],
  })
  await router.push('/home')
  await router.isReady()
  wrapper = mount(TagsView, { global: { plugins: [ElementPlus, i18n, router] } })
  await flushPromises()
  expect(useTagsStore().tags.map((tag) => tag.path)).toEqual(['/home', '/reports'])
  expect(useTagsStore().tags[1]).toMatchObject({
    fullPath: '/reports?month=10#totals',
    title: 'Current reports',
    icon: 'lucide:chart-line',
    cacheName: 'CurrentReport',
  })
  expect(wrapper.text()).toContain('Current reports')
  expect(wrapper.text()).not.toContain('Old name')
})
