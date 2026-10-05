// Menu add/edit form (iam/menu): a group's route name follows its full route path (a relative
// one below the parent's) until typed over and is required; once saved in the group format it is read-only
// (a page's stays editable); against a fake backend.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import type { MenuVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import TreeParentSelect from '@/core/components/TreeParentSelect.vue'
import MenuForm from '@/views/platform/iam/menu/form.vue'
import { mockApi, ok } from './mock-api'

const row = (over: Partial<MenuVo> = {}): MenuVo => ({
  id: 5,
  parentId: 0,
  treePath: '/5/',
  kind: 'group',
  name: 'Sales',
  nameI18n: null,
  routePath: '/erp/sale',
  component: null,
  componentName: null,
  routeName: 'erp-sale',
  routeQuery: null,
  linkType: 'route',
  linkUrl: null,
  perms: null,
  icon: null,
  sortNo: 0,
  visible: true,
  keepAlive: false,
  alwaysShow: false,
  enabled: true,
  createdBy: 1,
  createdAt: '2026-09-30T01:00:00.000Z',
  updatedBy: 1,
  updatedAt: '2026-09-30T01:00:00.000Z',
  ...over,
})

let form: VueWrapper
type Node = MenuVo & { children: Node[] }
const node = (over: Partial<MenuVo>, children: Node[] = []): Node => ({ ...row(over), children })
async function mountForm(
  props: { id?: number; parentId?: number } = {},
  loaded?: MenuVo,
  parents: Node[] = [],
) {
  mockApi({
    'GET /iam/menus': ok(parents),
    ...(loaded ? { 'GET /iam/menus/5': ok(loaded) } : {}),
    'GET /settings/dicts/iam.menu_kind/entries': ok({ version: 1, entries: [] }),
    'GET /settings/dicts/iam.menu_link_type/entries': ok({ version: 1, entries: [] }),
  })
  form = mount(MenuForm, {
    props,
    global: {
      plugins: [ElementPlus, i18n],
      stubs: { IconPicker: true, TreeParentSelect: true },
    },
    attachTo: document.body,
  })
  await flushPromises()
}
const item = (label: string) =>
  form.findAll('.el-form-item').find((i) => i.find('.el-form-item__label').text() === label)!
const input = (label: string) => item(label).find<HTMLInputElement>('input')

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
})
afterEach(() => {
  form.unmount()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('menu form', () => {
  it('a new group: the route name follows the route path until typed over, and is required', async () => {
    await mountForm()
    expect(item('Route name').classes()).toContain('is-required')
    await input('Route path').setValue('/erp')
    expect(input('Route name').element.value).toBe('erp')
    await input('Route path').setValue('/erp/Sale_2')
    expect(input('Route name').element.value).toBe('erp-sale-2')
    await input('Route name').setValue('sales')
    await input('Route path').setValue('/erp/sales')
    expect(input('Route name').element.value).toBe('sales')
    expect(input('Route name').element.disabled).toBe(false)
  })

  it('a saved group keeps its route name (read-only); a page or a group saved without one may set it', async () => {
    await mountForm({ id: 5 }, row())
    expect(input('Route name').element.value).toBe('erp-sale')
    expect(input('Route name').element.disabled).toBe(true)
    await input('Route path').setValue('/erp/orders')
    expect(input('Route name').element.value).toBe('erp-sale')
    form.unmount()

    await mountForm({ id: 5 }, row({ routeName: null, routePath: '/legacy' }))
    expect(input('Route name').element.disabled).toBe(false)
    expect(input('Route name').element.value).toBe('legacy')
    form.unmount()

    await mountForm(
      { id: 5 },
      row({ kind: 'page', component: 'home/index', routeName: 'IamThing' }),
    )
    expect(input('Route name').element.disabled).toBe(false)
    expect(item('Route name').classes()).not.toContain('is-required')
  })

  it('a relative route path hangs below the parent: the route name follows the parent too', async () => {
    // /erp (absolute) › ops (relative, so /erp/ops); /hr (absolute)
    const tree = [
      node({ id: 1, routePath: '/erp', routeName: 'erp' }, [
        node({ id: 2, parentId: 1, routePath: 'ops', routeName: 'erp-ops' }),
      ]),
      node({ id: 3, routePath: '/hr', routeName: 'hr' }),
    ]
    await mountForm({ parentId: 1 }, undefined, tree)
    await input('Route path').setValue('sale')
    expect(input('Route name').element.value).toBe('erp-sale')
    // an absolute path ignores the parent
    await input('Route path').setValue('/crm/sale')
    expect(input('Route name').element.value).toBe('crm-sale')
    await input('Route path').setValue('sale')
    const parent = form.findComponent(TreeParentSelect)
    // a parent below a relative one: its full path joins every ancestor's
    parent.vm.$emit('update:modelValue', 2)
    await flushPromises()
    expect(input('Route name').element.value).toBe('erp-ops-sale')
    parent.vm.$emit('update:modelValue', 3)
    await flushPromises()
    expect(input('Route name').element.value).toBe('hr-sale')
    // top level
    parent.vm.$emit('update:modelValue', 0)
    await flushPromises()
    expect(input('Route name').element.value).toBe('sale')

    // typed over: neither the parent nor the path changes it any more
    await input('Route name').setValue('sales-desk')
    parent.vm.$emit('update:modelValue', 1)
    await flushPromises()
    await input('Route path').setValue('desk')
    expect(input('Route name').element.value).toBe('sales-desk')
  })
})
