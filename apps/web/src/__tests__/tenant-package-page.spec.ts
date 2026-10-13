// Tenant package page against a fake backend: the form picks menus in the role grant tree (menus open to
// tenants), echoes a package's menus and saves the picked ones with their ancestors, an edit only when
// they changed (new menus reload every session); no save before the
// tree arrived (it would clear the package); enabling is the list's alone (an edit never sends it); a folded
// group stays folded when the tree re-renders; deleting goes one package at a time.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import type { RoleMenuNode, TenantPackageVo } from '@qiwu/shared'
import { dialogs } from '@/core/dialog'
import DialogHost from '@/core/dialog/DialogHost.vue'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import GrantTree from '@/views/platform/iam/role/grant-tree.vue'
import PackagePage from '@/views/platform/iam/tenant-package/index.vue'
import { me, mockApi, ok, type Route } from './mock-api'

const node = (
  id: number,
  name: string,
  children: RoleMenuNode[] = [],
  perms: string | null = null,
): RoleMenuNode => ({
  id,
  parentId: 0,
  kind: children.length ? 'group' : 'action',
  name,
  nameI18n: null,
  perms,
  enabled: true,
  children,
})
// Books > (Book list > (browse, create)); Topics
const TREE = [
  node(10, 'Books', [
    node(11, 'Book list', [
      node(12, 'Browse', [], 'demo.book.browse'),
      node(13, 'Create', [], 'demo.book.create'),
    ]),
  ]),
  node(20, 'Topics'),
]
const PKG: TenantPackageVo = {
  id: 5,
  name: 'Standard',
  enabled: true,
  note: null,
  tenantCount: 0,
  createdBy: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedBy: null,
  updatedAt: '2026-10-01T00:00:00.000Z',
}

const t = (key: string, params: Record<string, unknown> = {}) => i18n.global.t(key, params)
const body = () => new DOMWrapper(document.body)
const dialog = () => body().findAll('.el-dialog').at(-1)!
const button = (scope: DOMWrapper<Element>, text: string) =>
  scope.findAll('button').find((b) => b.text() === text)!
const treeNode = (text: string) =>
  dialog()
    .findAll('.el-tree-node__content')
    .find((n) => n.text().startsWith(text))!
const sent = (calls: { method?: string; data?: unknown }[], method: string) =>
  JSON.parse(calls.find((c) => c.method === method)!.data as string) as Record<string, unknown>
const sorted = (ids: unknown) => [...(ids as number[])].sort((a, b) => a - b)

let page: VueWrapper
let host: VueWrapper
async function mountPage(routes: Record<string, Route>) {
  const calls = mockApi({
    'GET /iam/tenant-packages': ok({ items: [PKG], total: 1 }),
    'GET /iam/profile/prefs/table.iam.tenantPackage': ok({ value: null }),
    'GET /settings/dicts/core.enabled/entries': ok({ version: 1, entries: [] }),
    'GET /iam/tenant-packages/menu-tree': ok(TREE),
    ...routes,
  })
  useAuthStore().me = me(['*'])
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  await router.push('/')
  const global = {
    plugins: [ElementPlus, i18n, router],
    directives: { perm: vPerm },
    stubs: { transition: false },
  }
  host = mount(DialogHost, { global, attachTo: document.body })
  page = mount(PackagePage, { global, attachTo: document.body })
  await flushPromises()
  return calls
}
const pageRow = () => new DOMWrapper(page.find('.el-table__body .el-table__row').element)

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
})
afterEach(() => {
  page?.unmount()
  host?.unmount()
  dialogs.splice(0)
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('tenant package page', () => {
  it('adds a package with the menus picked in the grant tree, ancestors included', async () => {
    const calls = await mountPage({ 'POST /iam/tenant-packages': ok({ ...PKG, id: 6 }) })
    await button(new DOMWrapper(page.element), t('crud.action.create')).trigger('click')
    await flushPromises()
    expect(host.findComponent(GrantTree).exists()).toBe(true)
    await button(dialog(), t('crud.action.expandAll')).trigger('click')
    expect(treeNode('Browse').text()).toContain('demo.book.browse')

    await dialog().find('.el-form-item input').setValue('Basic')
    await treeNode('Browse').find('.el-checkbox input').setValue(true)
    await button(dialog(), t('crud.action.save')).trigger('click')
    await flushPromises()

    const posted = sent(calls, 'post')
    expect(posted).toMatchObject({ name: 'Basic', enabled: true })
    expect(sorted(posted.menuIds)).toEqual([10, 11, 12])
  })

  it('an edit echoes the stored menus and leaves them out when unchanged; no save before the tree arrived', async () => {
    let answerTree = (): void => undefined
    const calls = await mountPage({
      'GET /iam/tenant-packages/5': ok({ ...PKG, menuIds: [10, 11, 12] }),
      'PUT /iam/tenant-packages/5': ok(null),
      'GET /iam/tenant-packages/menu-tree': () =>
        new Promise((resolve) => (answerTree = () => resolve(ok(TREE)))),
    })
    await button(pageRow(), t('crud.action.edit')).trigger('click')
    await flushPromises()
    const save = () => button(dialog(), t('crud.action.save'))
    expect(save().attributes('disabled')).toBeDefined()
    await save().trigger('click')
    await flushPromises()
    expect(calls.some((c) => c.method === 'put')).toBe(false)

    answerTree()
    await flushPromises()
    expect(save().attributes('disabled')).toBeUndefined()
    await button(dialog(), t('crud.action.expandAll')).trigger('click')
    const checked = (text: string) =>
      treeNode(text).find('.el-checkbox').classes().includes('is-checked')
    expect(checked('Browse')).toBe(true)
    expect(checked('Create')).toBe(false)
    expect(checked('Topics')).toBe(false)
    // no enabled switch in the form: the list switches it, after a confirm
    const labels = dialog()
      .findAll('.el-form-item__label')
      .map((l) => l.text())
    expect(labels).toContain(t('field.iam.tenantPackage.name'))
    expect(labels).not.toContain(t('field.iam.tenantPackage.enabled'))
    await dialog().find('.el-form-item input').setValue('Standard plus')
    await save().trigger('click')
    await flushPromises()
    const put = sent(calls, 'put')
    expect(put).toMatchObject({ name: 'Standard plus' })
    expect(put).not.toHaveProperty('menuIds')
    expect(put).not.toHaveProperty('enabled')
  })

  it('an edit sends the menus once they changed', async () => {
    const calls = await mountPage({
      'GET /iam/tenant-packages/5': ok({ ...PKG, menuIds: [10, 11, 12] }),
      'PUT /iam/tenant-packages/5': ok(null),
    })
    await button(pageRow(), t('crud.action.edit')).trigger('click')
    await flushPromises()
    await button(dialog(), t('crud.action.expandAll')).trigger('click')
    await treeNode('Create').find('.el-checkbox input').setValue(true)
    await button(dialog(), t('crud.action.save')).trigger('click')
    await flushPromises()
    expect(sorted(sent(calls, 'put').menuIds)).toEqual([10, 11, 12, 13])
  })

  it('a group the user folded stays folded when the tree re-renders', async () => {
    await mountPage({})
    await button(new DOMWrapper(page.element), t('crud.action.create')).trigger('click')
    await flushPromises()
    const books = () => treeNode('Books').element.parentElement!
    expect(books().classList).toContain('is-expanded')
    await treeNode('Books').find('.el-tree-node__expand-icon').trigger('click')
    await flushPromises()
    expect(books().classList).not.toContain('is-expanded')
    // the link switch re-renders the tree's form item: the tree stays as the user left it
    await dialog().find('.el-switch').trigger('click')
    await flushPromises()
    expect(books().classList).not.toContain('is-expanded')
  })

  it('shows a sample package’s name (an i18n key) translated: in the list, its switch and the disable confirm', async () => {
    const KEY = 'seed.tenantPackage.full'
    await mountPage({
      'GET /iam/tenant-packages': ok({ items: [{ ...PKG, name: KEY }], total: 1 }),
    })
    const shown = t(KEY)
    expect(shown).not.toBe(KEY)
    expect(pageRow().text()).toContain(shown)
    expect(pageRow().text()).not.toContain(KEY)
    expect(pageRow().find('.el-switch input').attributes('aria-label')).toContain(shown)
    await pageRow().find('.el-switch').trigger('click')
    await flushPromises()
    expect(body().find('.el-message-box').text()).toContain(shown)
    await body().find('.el-message-box__btns .el-button:not(.el-button--primary)').trigger('click')
    await flushPromises()
  })

  it('deletes one package after a confirm', async () => {
    const calls = await mountPage({ 'DELETE /iam/tenant-packages/5': ok(null) })
    await button(pageRow(), t('crud.action.delete')).trigger('click')
    await flushPromises()
    await body().find('.el-message-box__btns .el-button--primary').trigger('click')
    await flushPromises()
    expect(calls.filter((c) => c.method === 'delete').map((c) => c.url)).toEqual([
      '/iam/tenant-packages/5',
    ])
  })
})
