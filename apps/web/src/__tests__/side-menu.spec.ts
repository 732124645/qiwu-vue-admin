import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMenu, ElMenuItem, ElSubMenu } from 'element-plus'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import type { MenuNode } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { Icon } from '@/core/icons'
import SideMenu from '@/core/layout/SideMenu.vue'
import { useMenuStore } from '@/core/stores/menu'
import { node } from './mock-api'

let router: Router
let wrapper: VueWrapper
const group = (index: string) =>
  wrapper.findAllComponents(ElSubMenu).find((item) => item.props('index') === index)!

beforeEach(async () => {
  setActivePinia(createPinia())
  setLocale('en-US')
  const page = { render: () => null }
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/a/inner/p2', component: page, meta: { menuId: 4 } },
      { path: '/b/p3', component: page, meta: { menuId: 6 } },
    ],
  })
  await router.push('/a/inner/p2')
  useMenuStore().tree = [
    node({
      id: 1,
      kind: 'group',
      name: 'A',
      routePath: '/a',
      icon: 'lucide:folder',
      children: [
        node({ id: 2, routePath: 'p1', name: 'P1' }),
        node({
          id: 3,
          kind: 'group',
          alwaysShow: true,
          name: 'Inner',
          routePath: 'inner',
          children: [node({ id: 4, routePath: 'p2', name: 'P2' })],
        }),
      ],
    }),
    node({
      id: 5,
      kind: 'group',
      alwaysShow: true,
      name: 'B',
      routePath: '/b',
      icon: 'lucide:folder',
      children: [node({ id: 6, routePath: 'p3', name: 'P3' })],
    }),
  ]
  wrapper = mount(SideMenu, { global: { plugins: [ElementPlus, i18n, router] } })
  await flushPromises()
})
afterEach(() => {
  wrapper.unmount()
  vi.restoreAllMocks()
})

describe('SideMenu', () => {
  it('renders top-level and nested groups as sub-menus, with only the active trail open initially', () => {
    expect(wrapper.findAll('.el-menu-item-group')).toHaveLength(0)
    expect(wrapper.findAll('.el-sub-menu')).toHaveLength(3)
    expect(group('/a').classes()).toContain('is-opened')
    expect(group('/a/inner').classes()).toContain('is-opened')
    expect(group('/b').classes()).not.toContain('is-opened')
    expect(group('/a').find('.el-sub-menu__title').text()).toContain('A')
    expect(group('/a').find('.el-sub-menu__title .el-icon').exists()).toBe(true)
  })

  it('opens the new page trail without closing groups the user opened', async () => {
    await group('/b').find('.el-sub-menu__title').trigger('click')
    expect(group('/b').classes()).toContain('is-opened')
    await group('/a').find('.el-sub-menu__title').trigger('click')
    expect(group('/a').classes()).not.toContain('is-opened')

    await router.push('/b/p3')
    await flushPromises()
    expect(group('/a').classes()).not.toContain('is-opened')
    await router.push('/a/inner/p2')
    await flushPromises()
    expect(group('/a').classes()).toContain('is-opened')
    expect(group('/a/inner').classes()).toContain('is-opened')
    expect(group('/b').classes()).toContain('is-opened')
  })

  it('opens an alwaysShow single-child group on the current route on a fresh mount', async () => {
    wrapper.unmount()
    useMenuStore().tree = [
      node({
        id: 1,
        kind: 'group',
        routePath: '/a',
        alwaysShow: true,
        children: [node({ id: 4, routePath: 'inner/p2' })],
      }),
    ]
    wrapper = mount(SideMenu, { global: { plugins: [ElementPlus, i18n, router] } })
    await flushPromises()
    expect(wrapper.findComponent(ElMenu).props('defaultOpeneds')).toEqual(['/a'])
    expect(group('/a').classes()).toContain('is-opened')
  })

  it('keeps top-level group icons as 64px collapse triggers and restores the current trail', async () => {
    await wrapper.setProps({ collapsed: true })
    expect(wrapper.find('.el-menu--collapse').exists()).toBe(true)
    expect(group('/a').find('.el-sub-menu__title .el-icon').exists()).toBe(true)
    await wrapper.setProps({ collapsed: false })
    expect(group('/a').classes()).toContain('is-opened')
    expect(group('/a/inner').classes()).toContain('is-opened')
    expect(group('/b').classes()).not.toContain('is-opened')
  })

  it.each([
    [0, false, 0],
    [0, true, 0],
    [1, false, 0],
    [1, true, 1],
    [2, false, 1],
    [2, true, 1],
  ])(
    'renders %i visible children with alwaysShow=%s as %i groups',
    async (count, alwaysShow, groups) => {
      useMenuStore().tree = [
        node({
          id: 1,
          kind: 'group',
          name: 'Parent',
          routePath: '/a',
          alwaysShow,
          children: [
            ...Array.from({ length: count }, (_, i) =>
              node({ id: i + 2, name: `Page ${i}`, routePath: `p${i}` }),
            ),
            node({ id: 10, name: 'Hidden', routePath: 'hidden', visible: false }),
            // The API excludes actions from MenuNode; a legacy action row must not count as a page.
            {
              ...node({ id: 11, name: 'Action', routePath: '' }),
              kind: 'action',
            } as unknown as MenuNode,
            node({ id: 12, name: 'Empty', routePath: 'empty', kind: 'group' }),
          ],
        }),
      ]
      await flushPromises()
      expect(wrapper.findAllComponents(ElSubMenu)).toHaveLength(groups)
      expect(wrapper.findAllComponents(ElMenuItem)).toHaveLength(count)
      expect(wrapper.text()).not.toMatch(/Hidden|Action|Empty/)
      expect(wrapper.text().includes('Parent')).toBe(groups > 0)
    },
  )

  it('recursively collapses groups while keeping deep iframe paths, active state and breadcrumbs', async () => {
    const menu = useMenuStore()
    menu.tree = [
      node({
        id: 1,
        kind: 'group',
        name: 'Parent',
        routePath: '/a',
        children: [
          node({
            id: 3,
            kind: 'group',
            name: 'Inner',
            routePath: 'inner',
            children: [
              node({
                id: 4,
                name: 'Frame',
                routePath: 'p2',
                linkType: 'iframe',
                linkUrl: 'https://example.com/frame',
                icon: 'lucide:file',
              }),
            ],
          }),
        ],
      }),
    ]
    const routes = menu.routes
    const trail = menu.trail(4)
    await flushPromises()
    expect(wrapper.findAllComponents(ElSubMenu)).toHaveLength(0)
    const item = wrapper.findComponent(ElMenuItem)
    expect(item.props('index')).toBe('/a/inner/p2')
    expect(item.classes()).toContain('is-active')
    expect(item.text()).toBe('Frame')
    expect(item.find('.el-icon').exists()).toBe(true)
    await router.push('/b/p3')
    await flushPromises()
    expect(item.classes()).not.toContain('is-active')
    await item.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/a/inner/p2')
    expect(item.classes()).toContain('is-active')
    await wrapper.setProps({ collapsed: true })
    await wrapper.setProps({ collapsed: false })
    menu.tree[0]!.alwaysShow = true
    await flushPromises()
    expect(group('/a').classes()).toContain('is-opened')
    expect(wrapper.findAllComponents(ElSubMenu)).toHaveLength(1)
    menu.tree[0]!.alwaysShow = false
    await flushPromises()
    expect(wrapper.findAllComponents(ElSubMenu)).toHaveLength(0)
    expect(menu.routes).toEqual(routes)
    expect(menu.routes[0]?.meta?.linkUrl).toBe('https://example.com/frame')
    expect(menu.trail(4)).toEqual(trail)
    expect(trail.map(({ path }) => path)).toEqual(['/a', '/a/inner', '/a/inner/p2'])
  })

  it('keeps a collapsed external child icon, URL and safe new-tab behavior', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    useMenuStore().tree = [
      node({
        id: 1,
        kind: 'group',
        routePath: '/a',
        children: [
          node({
            id: 2,
            name: 'External',
            routePath: 'external',
            linkType: 'external',
            linkUrl: 'https://example.com/docs',
            icon: 'lucide:book',
          }),
        ],
      }),
    ]
    await flushPromises()
    const item = wrapper.findComponent(ElMenuItem)
    expect(wrapper.findAllComponents(ElSubMenu)).toHaveLength(0)
    expect(item.props('index')).toBe('https://example.com/docs')
    expect(item.text()).toBe('External')
    expect(item.findAll('.el-icon')).toHaveLength(2)
    expect(item.find('.side-menu__ext').exists()).toBe(true)
    await item.trigger('click')
    expect(open).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer')
    expect(router.currentRoute.value.path).toBe('/a/inner/p2')
  })

  it('uses the parent icon for an iconless collapsed child in the 64px sidebar', async () => {
    const menu = useMenuStore()
    const parent = menu.tree[0]!
    parent.children = [node({ id: 4, name: 'Page', routePath: 'inner/p2', icon: null })]
    const child = parent.children[0]!
    await wrapper.setProps({ collapsed: true })
    await flushPromises()
    expect(wrapper.findComponent(ElMenuItem).findComponent(Icon).props('icon')).toBe(parent.icon)
    expect(child.icon).toBeNull()
    expect(menu.routes.find((route) => route.path === '/a/inner/p2')?.meta?.icon).toBeNull()
  })

  it('preserves mix root labels and firstPage navigation through a collapsed nested group', async () => {
    const menu = useMenuStore()
    menu.tree[0]!.children = [
      node({
        id: 3,
        kind: 'group',
        name: 'Inner',
        routePath: 'inner',
        children: [
          node({
            id: 7,
            routePath: 'external',
            linkType: 'external',
            linkUrl: 'https://example.com',
          }),
          node({ id: 8, routePath: 'hidden', visible: false }),
          node({ id: 4, routePath: 'p2', name: 'P2' }),
        ],
      }),
    ]
    await wrapper.setProps({ horizontal: true, roots: true })
    await flushPromises()
    expect(wrapper.findAllComponents(ElSubMenu)).toHaveLength(0)
    const item = wrapper.findAllComponents(ElMenuItem).find((c) => c.props('index') === '/a')!
    expect(item.text()).toBe('A')
    expect(item.classes()).toContain('is-active')
    await router.push('/b/p3')
    await flushPromises()
    await item.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/a/inner/p2')
    expect(item.classes()).toContain('is-active')
    await wrapper.setProps({
      horizontal: false,
      roots: false,
      nodes: menu.tree[0]!.children,
      base: '/a',
    })
    await flushPromises()
    expect(group('/a/inner').exists()).toBe(true)
    expect(wrapper.findAllComponents(ElMenuItem).map((c) => c.props('index'))).toEqual([
      'https://example.com',
      '/a/inner/p2',
    ])
  })
})
