// Generator page 2 (see docs/design-notes.md#codegen): one table's config in three tabs, the editable column grid, the
// template's linked fields, the dict and parent-menu pickers, the references, the checked save;
// against the fake backend.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, {
  ElMessage,
  ElOption,
  ElSelect,
  ElSelectV2,
  ElSwitch,
  ElTreeSelect,
} from 'element-plus'
import type { CgColumnVo, CgTableDetailVo, CgTableUpdate } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import CodegenEdit from '@/views/platform/codegen/edit.vue'
import { me, mockApi, ok, type Route } from './mock-api'

const col = (id: number, columnName: string, extra: Partial<CgColumnVo> = {}): CgColumnVo => ({
  id,
  columnName,
  columnType: 'varchar(64)',
  columnComment: `${columnName} comment`,
  columnDefault: null,
  nullable: false,
  isPk: false,
  isAutoInc: false,
  fieldName: columnName.replace(/_(\w)/g, (_, c: string) => c.toUpperCase()),
  tsType: 'string',
  widget: 'input',
  inList: true,
  inForm: true,
  inQuery: false,
  queryOp: 'eq',
  sortable: false,
  required: true,
  dictCode: null,
  labelI18n: { 'zh-CN': `${columnName} zh`, 'en-US': `${columnName} en` },
  options: null,
  sortNo: id * 10,
  example: null,
  ...extra,
})
const detail = (extra: Partial<CgTableDetailVo> = {}): CgTableDetailVo => ({
  id: 5,
  tableName: 'demo_shelf',
  tableComment: 'Shelves',
  groupCode: 'biz',
  domain: 'demo',
  business: 'shelf',
  className: 'Shelf',
  featureName: 'Shelves',
  featureNameI18n: { 'zh-CN': 'shelves zh', 'en-US': 'Shelves' },
  template: 'crud',
  parentMenuRouteName: 'demo',
  treeParentCol: null,
  treeLabelCol: null,
  masterTableId: null,
  subFkCol: null,
  formCols: 1,
  withDetailView: false,
  readonly: false,
  options: { withExport: true },
  note: null,
  createdAt: '2026-09-27T01:00:00.000Z',
  updatedAt: '2026-09-27T02:00:00.000Z',
  columns: [
    col(1, 'id', { isPk: true, tsType: 'number', widget: 'number', inForm: false, inList: false }),
    col(2, 'parent_id', { tsType: 'number', widget: 'number' }),
    col(3, 'title', { inQuery: true, queryOp: 'like' }),
    col(4, 'shelf_kind'),
    col(5, 'dept_id', {
      columnType: 'bigint unsigned',
      tsType: 'number',
      widget: 'dept-tree-select',
      required: false,
    }),
  ],
  ...extra,
})

function backend(d = detail(), extra: Record<string, Route> = {}) {
  return mockApi({
    'GET /codegen/tables/5': () => ok(d),
    // the master picker: configs of template master_sub (this one never)
    'GET /codegen/tables': ok({
      items: [
        { ...detail(), id: 7, tableName: 'demo_order', template: 'master_sub' },
        {
          ...detail(),
          id: 8,
          tableName: 'demo_plain',
          tableComment: 'Plain rows',
          template: 'crud',
        },
      ],
      total: 2,
    }),
    'PUT /codegen/tables/5': ok(null),
    'GET /codegen/tables/parent-menus': ok([
      {
        id: 1,
        routeName: 'devtools',
        name: 'menu.devtools.title',
        nameI18n: null,
        pickable: true,
        reason: null,
        children: [
          {
            id: 2,
            routeName: 'demo',
            name: 'Samples',
            nameI18n: { 'en-US': 'Samples EN' },
            pickable: true,
            reason: null,
            children: [],
          },
        ],
      },
      {
        id: 3,
        routeName: null,
        name: 'Legacy',
        nameI18n: null,
        pickable: false,
        reason: 'route_name',
        children: [
          {
            id: 4,
            routeName: 'legacy-sub',
            name: 'Sub',
            nameI18n: null,
            pickable: false,
            reason: 'ancestor',
            children: [],
          },
        ],
      },
    ]),
    'GET /settings/dicts/options': ok([
      { code: 'demo.genre', name: 'Genre', nameI18n: { 'en-US': 'Book genre' } },
      { code: 'demo.shelf_kind', name: 'Shelf kind', nameI18n: null },
    ]),
    // the reference pickers: tables not imported yet, and the columns of a config's table
    'GET /codegen/tables/importable': ok([
      { tableName: 'biz_shelf_slot', tableComment: 'Slots', noDeletedAt: false },
    ]),
    'GET /codegen/tables/8': ok(
      detail({
        id: 8,
        tableName: 'demo_plain',
        columns: [
          col(1, 'id', { isPk: true, columnType: 'bigint unsigned' }),
          col(2, 'shelf_id', { columnType: 'bigint unsigned' }),
          col(3, 'title'),
          col(4, 'created_by', { columnType: 'bigint unsigned' }),
        ],
      }),
    ),
    ...extra,
  })
}

let page: VueWrapper
async function mountPage(perms = ['*']) {
  useAuthStore().me = me(perms)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/codegen/tables', component: { render: () => null } },
      { path: '/codegen/tables/:id', component: CodegenEdit },
    ],
  })
  await router.push('/codegen/tables/5')
  page = mount(CodegenEdit, {
    global: {
      plugins: [ElementPlus, i18n, router],
      directives: { perm: vPerm },
      // no case opens a grid dropdown or the menu tree: stubs keep their props and v-model events
      // without rendering ~25 Element Plus poppers per mount (slow under happy-dom)
      stubs: { IconPicker: true, ElSelectV2: true, ElTreeSelect: true },
    },
    attachTo: document.body,
  })
  await flushPromises()
}
const input = (selector: string) => page.find<HTMLInputElement>(`input${selector}`)
const select = (label: string) =>
  page.findAllComponents(ElSelectV2).find((s) => s.props('ariaLabel') === label)!
const choose = async (label: string, value: unknown) => {
  select(label).vm.$emit('update:modelValue', value)
  await flushPromises()
}
const saveButton = () => page.findAll('button').find((b) => b.text() === 'Save')
const refSelect = (label: string) =>
  page.findAllComponents(ElSelect).find((s) => s.props('ariaLabel') === label)!
const refRows = () => page.findAll('.qw-edit-table .el-table__body .el-table__row')
const put = (calls: { method?: string; url?: string; data?: unknown }[]) =>
  calls.filter((c) => c.method === 'put').map((c) => JSON.parse(c.data as string) as CgTableUpdate)
const radio = (text: string) =>
  page
    .findAll('.el-radio-button')
    .find((r) => r.text() === text)!
    .find('input')

let error: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  error = vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
  vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
})
afterEach(() => {
  page.unmount()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('codegen edit', () => {
  it('shows the config in three tabs with the column grid and the pickers', async () => {
    backend()
    await mountPage()
    expect(page.find('.qw-page-bar__context').text()).toBe('demo_shelf')
    expect(page.findAll('.el-tabs__item').map((n) => n.text())).toEqual([
      'Basic info',
      'Columns',
      'Generation',
    ])
    expect(input('[name="className"]').element.value).toBe('Shelf')
    expect(input('[name="featureName-en-US"]').element.value).toBe('Shelves')

    const rows = page.findAll('.codegen-edit__columns .el-table__body .el-table__row')
    expect(rows.map((r) => r.find('.codegen-edit__column span').text())).toEqual([
      'id',
      'parent_id',
      'title',
      'shelf_kind',
      'dept_id',
    ])
    expect(input('[aria-label="Property name shelf_kind"]').element.value).toBe('shelfKind')
    // dicts by their localized name; the query operator only with the search condition on
    expect(select('Dictionary code title').props('options')).toEqual([
      { value: 'demo.genre', label: 'Book genre (demo.genre)' },
      { value: 'demo.shelf_kind', label: 'Shelf kind (demo.shelf_kind)' },
    ])
    expect(select('Search operator title').props('disabled')).toBe(false)
    expect(select('Search operator shelf_kind').props('disabled')).toBe(true)

    const tree = page.findComponent(ElTreeSelect)
    expect(tree.props('modelValue')).toBe('demo')
    // every group; the ones a page cannot go under disabled, with the reason
    type Option = { value: string; disabled: boolean; children: Option[] }
    const options = tree.props('data') as Option[]
    const flat = (list: Option[]): [string, boolean][] =>
      list.flatMap((o) => [[o.value, o.disabled], ...flat(o.children)])
    expect(flat(options)).toEqual([
      ['devtools', false],
      ['demo', false],
      ['#3', true],
      ['legacy-sub', true],
    ])
    const label = (tree.props('props') as { label: (n: object) => string }).label
    expect(label(options[0]!.children[0]!)).toBe('Samples EN')
    expect(label(options[1]!)).toBe(
      'Legacy (its route name is missing or not lowercase letters, digits and hyphens)',
    )
    expect(label(options[1]!.children[0]!)).toBe('Sub (a group above it has no such route name)')
    // the dept_id column offers the data-scope switch, on unless switched off
    expect(page.text()).toContain('Data scope by department')
  })

  it('saves the table fields and every column, with the tree template linked columns', async () => {
    const calls = backend(
      detail({
        options: {
          withExport: true,
          descriptionI18n: { 'zh-CN': '旧说明', 'en-US': 'Old description' },
        } as CgTableDetailVo['options'],
      }),
    )
    await mountPage()
    await input('[name="className"]').setValue('BookShelf')
    await input('[aria-label="Field label English shelf_kind"]').setValue('Kind')
    await choose('Form widget shelf_kind', 'select')
    await choose('Dictionary code shelf_kind', 'demo.shelf_kind')
    await page.find('[aria-label="Search condition shelf_kind"] input').setValue(true)
    await choose('Search operator shelf_kind', 'like')

    await radio('Tree').setValue(true)
    await flushPromises()
    expect(page.find('input[name="treeParentCol"]').exists()).toBe(true)
    expect(page.text()).toContain('A tree gets no detail drawer')
    expect(page.text()).not.toContain('Detail drawer')

    await saveButton()!.trigger('click')
    await flushPromises()
    const [dto] = put(calls)
    expect(dto).toMatchObject({
      className: 'BookShelf',
      template: 'tree',
      treeParentCol: 'parent_id',
      treeLabelCol: 'title',
      masterTableId: null,
      subFkCol: null,
      parentMenuRouteName: 'demo',
      note: null,
      options: { withExport: true },
    })
    // blank per-language texts are left out, not sent empty
    expect(dto!.options).not.toHaveProperty('entityI18n')
    expect(dto!.options).not.toHaveProperty('descriptionI18n')
    expect(dto!.columns).toHaveLength(5)
    expect(dto!.columns![3]).toEqual({
      id: 4,
      fieldName: 'shelfKind',
      tsType: 'string',
      widget: 'select',
      inList: true,
      inForm: true,
      inQuery: true,
      queryOp: 'like',
      sortable: false,
      required: true,
      dictCode: 'demo.shelf_kind',
      labelI18n: { 'zh-CN': 'shelf_kind zh', 'en-US': 'Kind' },
      options: {},
      sortNo: 40,
      example: null,
    })
    // reloaded after the save
    expect(calls.filter((c) => c.url === '/codegen/tables/5' && c.method === 'get')).toHaveLength(2)

    // back to single table: the tree columns go null
    await radio('Single table').setValue(true)
    await saveButton()!.trigger('click')
    await flushPromises()
    expect(put(calls)[1]).toMatchObject({
      template: 'crud',
      treeParentCol: null,
      treeLabelCol: null,
    })
  })

  it('another domain or business re-derives the class name and dict codes still at their derivation', async () => {
    const columns = detail().columns
    const derived = (className: string) =>
      detail({
        className,
        columns: [
          ...columns.map((c) =>
            c.columnName === 'shelf_kind'
              ? { ...c, dictCode: 'demo.shelf_kind' }
              : c.columnName === 'title'
                ? { ...c, dictCode: 'demo.genre' }
                : c,
          ),
          col(6, 'kind', { dictCode: 'demo.shelf_kind' }),
        ],
      })
    const calls = backend(derived('Shelf'))
    await mountPage()
    await input('[name="domain"]').setValue('erp')
    await input('[name="business"]').setValue('rack')
    expect(input('[name="className"]').element.value).toBe('Rack')
    await saveButton()!.trigger('click')
    await flushPromises()
    const [dto] = put(calls)
    expect([dto!.domain, dto!.business, dto!.className]).toEqual(['erp', 'rack', 'Rack'])
    const dicts = Object.fromEntries(dto!.columns!.map((c) => [c.id, c.dictCode]))
    // `<domain>.<column>`, a bare kind `<domain>.<business>_kind`; a picked one stays
    expect([dicts[4], dicts[6], dicts[3]]).toEqual([
      'erp.shelf_kind',
      'erp.rack_kind',
      'demo.genre',
    ])
    page.unmount()

    // the domain in front (a business another domain has) follows; an edited class name stays
    backend(derived('DemoShelf'))
    await mountPage()
    await input('[name="domain"]').setValue('erp')
    expect(input('[name="className"]').element.value).toBe('ErpShelf')
    // a cleared domain derives both alike: typed again, the domain stays in front
    await input('[name="domain"]').setValue('')
    await input('[name="domain"]').setValue('crm')
    expect(input('[name="className"]').element.value).toBe('CrmShelf')
    page.unmount()
    backend(derived('BookShelf'))
    await mountPage()
    await input('[name="business"]').setValue('rack')
    expect(input('[name="className"]').element.value).toBe('BookShelf')
  })

  it('checks the config before saving: the message names the field, the tab shows it', async () => {
    const calls = backend()
    await mountPage()
    await input('[aria-label="Property name title"]').setValue('Bad-Name')
    await saveButton()!.trigger('click')
    expect(error).toHaveBeenLastCalledWith('Column title: Property name has an invalid format')
    expect(page.find('.el-tabs__item.is-active').text()).toBe('Columns')

    await input('[aria-label="Property name title"]').setValue('title')
    await input('[name="featureName-en-US"]').setValue('')
    await saveButton()!.trigger('click')
    expect(error.mock.lastCall?.[0]).toMatch(/^Feature name · English/)
    expect(page.find('.el-tabs__item.is-active').text()).toBe('Basic info')
    expect(put(calls)).toHaveLength(0)
  })

  it('the parent menu is never cleared: no clear button; a config stored without one is not saved', async () => {
    const calls = backend(detail({ parentMenuRouteName: null as unknown as string }))
    await mountPage()
    expect(page.findComponent(ElTreeSelect).props('clearable')).toBe(false)
    await saveButton()!.trigger('click')
    expect(error.mock.lastCall?.[0]).toMatch(/^Parent menu/)
    expect(page.find('.el-tabs__item.is-active').text()).toBe('Generation')
    expect(put(calls)).toHaveLength(0)
  })

  it('the parent-menu picker fetches the groups again each time it opens', async () => {
    const calls = backend()
    await mountPage()
    const fetched = () => calls.filter((c) => c.url === '/codegen/tables/parent-menus').length
    expect(fetched()).toBe(1)
    const tree = page.findComponent(ElTreeSelect)
    tree.vm.$emit('visible-change', true)
    await flushPromises()
    expect(fetched()).toBe(2)
    tree.vm.$emit('visible-change', false)
    await flushPromises()
    expect(fetched()).toBe(2)
  })

  it('links a single-table config to a master as its sub table', async () => {
    const calls = backend()
    await mountPage()
    await page.findAll('.el-tabs__item')[2]!.trigger('click')
    const byName = (name: string) =>
      page.findAllComponents(ElSelect).find((s) => s.props('name') === name)
    // only master_sub configs are offered
    expect(page.text()).toContain('Master table config')
    byName('masterTableId')!.vm.$emit('update:modelValue', 7)
    await flushPromises()
    // the fk column starts on the first integer *_id column
    expect(byName('subFkCol')!.props('modelValue')).toBe('dept_id')
    await saveButton()!.trigger('click')
    await flushPromises()
    expect(put(calls)[0]).toMatchObject({ masterTableId: 7, subFkCol: 'dept_id' })

    // unlinked: both null again; a master_sub config shows where its subs link from
    byName('masterTableId')!.vm.$emit('update:modelValue', undefined)
    await flushPromises()
    expect(byName('subFkCol')).toBeUndefined()
    await radio('Master-detail').setValue(true)
    await flushPromises()
    expect(byName('masterTableId')).toBeUndefined()
    await saveButton()!.trigger('click')
    await flushPromises()
    expect(put(calls)[1]).toMatchObject({
      template: 'master_sub',
      masterTableId: null,
      subFkCol: null,
    })
  })

  it('the mobile pages switch: saved as options.withMobile; none for a sub table', async () => {
    const calls = backend()
    await mountPage()
    await page.findAll('.el-tabs__item')[2]!.trigger('click')
    const mobileSwitch = () =>
      page
        .findAll('.el-form-item')
        .find((f) => f.find('.el-form-item__label').text() === 'Mobile pages')
        ?.findComponent(ElSwitch)
    mobileSwitch()!.vm.$emit('update:modelValue', true)
    await flushPromises()
    await saveButton()!.trigger('click')
    await flushPromises()
    expect(put(calls)[0]!.options).toMatchObject({ withMobile: true })
    // a sub table's pages are its master's
    page
      .findAllComponents(ElSelect)
      .find((s) => s.props('name') === 'masterTableId')!
      .vm.$emit('update:modelValue', 7)
    await flushPromises()
    expect(mobileSwitch()).toBeUndefined()
  })

  it('read-only hides import; no modify perm, no save', async () => {
    const calls = backend(detail({ readonly: true, options: null }))
    await mountPage(['codegen.table.view'])
    expect(page.text()).toContain('Read-only page')
    expect(page.text()).not.toContain('Import')
    expect(saveButton()).toBeUndefined()
    // the importable tables need the import perm: the reference picker offers the configs only
    expect(calls.some((c) => c.url === '/codegen/tables/importable')).toBe(false)
  })

  it('edits the references: tables of configs and importable ones, the columns of a config, add and delete', async () => {
    const calls = backend(
      detail({
        options: {
          withExport: true,
          referencedBy: [{ table: 'gone_table', column: 'shelf_id', label: 'Gone' }],
        },
      }),
    )
    await mountPage()
    expect(refRows()).toHaveLength(1)
    expect(refSelect('Referencing table 1').props('modelValue')).toBe('gone_table')
    expect(refSelect('Referencing column 1').props('modelValue')).toBe('shelf_id')
    expect(input('[aria-label="Reference label 1"]').element.value).toBe('Gone')
    // the imported configs and the importable tables, by name
    expect(
      refSelect('Referencing table 1')
        .findAllComponents(ElOption)
        .map((o) => o.props('value')),
    ).toEqual(['biz_shelf_slot', 'demo_order', 'demo_plain'])

    await page
      .findAll('button')
      .find((b) => b.text() === 'Add row')!
      .trigger('click')
    await flushPromises()
    expect(refRows()).toHaveLength(2)
    // a picked table fills a blank label with its comment
    refSelect('Referencing table 2').vm.$emit('update:modelValue', 'biz_shelf_slot')
    await flushPromises()
    expect(input('[aria-label="Reference label 2"]').element.value).toBe('Slots')
    // a config's table: its id columns (integer, not the key nor an audit one) once the column picker
    // opens; the label follows the table's comment
    refSelect('Referencing table 2').vm.$emit('update:modelValue', 'demo_plain')
    refSelect('Referencing column 2').vm.$emit('visible-change', true)
    await flushPromises()
    expect(calls.filter((c) => c.url === '/codegen/tables/8')).toHaveLength(1)
    expect(
      refSelect('Referencing column 2')
        .findAllComponents(ElOption)
        .map((o) => o.props('value')),
    ).toEqual(['shelf_id'])
    refSelect('Referencing column 2').vm.$emit('update:modelValue', 'shelf_id')
    await flushPromises()
    expect(input('[aria-label="Reference label 2"]').element.value).toBe('Plain rows')
    // a typed label stays on another table
    await input('[aria-label="Reference label 1"]').setValue('Old links')
    refSelect('Referencing table 1').vm.$emit('update:modelValue', 'biz_shelf_slot')
    await flushPromises()
    expect(input('[aria-label="Reference label 1"]').element.value).toBe('Old links')

    // the stale one goes: the page saves without it
    await refRows()[0]!.find('button').trigger('click')
    await flushPromises()
    await saveButton()!.trigger('click')
    await flushPromises()
    expect(put(calls)[0]!.options).toEqual({
      withExport: true,
      referencedBy: [{ table: 'demo_plain', column: 'shelf_id', label: 'Plain rows' }],
    })

    // none left: none stored
    await refRows()[0]!.find('button').trigger('click')
    await flushPromises()
    await saveButton()!.trigger('click')
    await flushPromises()
    expect(put(calls)[1]!.options).toEqual({ withExport: true })
  })

  it('checks each reference before saving: the message names the row and its field', async () => {
    const calls = backend()
    await mountPage()
    await page
      .findAll('button')
      .find((b) => b.text() === 'Add row')!
      .trigger('click')
    await flushPromises()
    await saveButton()!.trigger('click')
    expect(error).toHaveBeenLastCalledWith('Referenced by 1: Referencing table is required')
    expect(page.find('.el-tabs__item.is-active').text()).toBe('Generation')

    refSelect('Referencing table 1').vm.$emit('update:modelValue', 'Bad Table')
    await flushPromises()
    await saveButton()!.trigger('click')
    expect(error).toHaveBeenLastCalledWith(
      'Referenced by 1: Referencing table has an invalid format',
    )
    refSelect('Referencing table 1').vm.$emit('update:modelValue', 'biz_shelf_slot')
    await flushPromises()
    await saveButton()!.trigger('click')
    expect(error).toHaveBeenLastCalledWith('Referenced by 1: Referencing column is required')
    refSelect('Referencing column 1').vm.$emit('update:modelValue', 'shelf_id')
    // another table clears the column: it named one of the old table
    refSelect('Referencing table 1').vm.$emit('update:modelValue', 'demo_order')
    await flushPromises()
    await saveButton()!.trigger('click')
    expect(error).toHaveBeenLastCalledWith('Referenced by 1: Referencing column is required')
    refSelect('Referencing column 1').vm.$emit('update:modelValue', 'shelf_id')
    await input('[aria-label="Reference label 1"]').setValue(' ')
    await saveButton()!.trigger('click')
    expect(error).toHaveBeenLastCalledWith('Referenced by 1: Reference label is required')
    expect(put(calls)).toHaveLength(0)
  })
})
