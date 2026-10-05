// The CRUD kit (see docs/design-notes.md#crud-kit): crudApi URLs, useCrudList / useCrudForm / useDict and the toolbar, pagination and
// dict select components, against the fake backend.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus, {
  ElForm,
  ElFormItem,
  ElInput,
  ElMessage,
  ElMessageBox,
  ElPagination,
} from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { DemoEventCreate, DemoNoteCreate } from '@qiwu/shared/testing'
import DictSelect from '@/core/components/DictSelect.vue'
import Pagination from '@/core/components/Pagination.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { listParams, useCrudForm, useCrudList, useTreeList } from '@/core/composables/use-crud'
import { useDict } from '@/core/composables/use-dict'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken, crudApi, treeApi } from '@/core/request/http'
import { fail, mockApi, ok, type Route } from './mock-api'

interface Note {
  id: number
  title: string
  email: string
  quantity: number | null
}
const notes = crudApi<Note>('/demo/notes')
const note = (id: number): Note => ({ id, title: `note ${id}`, email: 'a@b.co', quantity: id })
const page = (ids: number[], total = ids.length) => ok({ items: ids.map(note), total })

/** A fake endpoint that answers only when the test says so. */
function later() {
  let answer = (_reply: ReturnType<typeof ok>) => {}
  const route: Route = () => new Promise((resolve) => (answer = resolve))
  return { route, answer: (reply: ReturnType<typeof ok>) => answer(reply) }
}

let confirm: ReturnType<typeof vi.spyOn>
let success: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  setActivePinia(createPinia())
  accessToken.value = 'at'
  localStorage.clear()
  confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
  success = vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
  error = vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
})
afterEach(() => {
  vi.restoreAllMocks()
  setLocale('zh-CN')
})

const sent = (c: { method?: string; url?: string; params?: unknown; data?: unknown }) => ({
  call: `${c.method?.toUpperCase()} ${c.url}`,
  ...(c.params ? { params: c.params } : {}),
  ...(c.data ? { data: JSON.parse(c.data as string) as unknown } : {}),
})

describe('crudApi', () => {
  it('maps the standard CRUD endpoints', async () => {
    const calls = mockApi({
      'GET /demo/notes': page([1]),
      'GET /demo/notes/1': ok(note(1)),
      'POST /demo/notes': ok(note(2)),
      'PUT /demo/notes/2': ok(null),
      'DELETE /demo/notes/2': ok(null),
      'POST /demo/notes/batch-delete': ok(null),
    })
    await expect(notes.page({ page: 1 })).resolves.toEqual({ items: [note(1)], total: 1 })
    await expect(notes.get(1)).resolves.toEqual(note(1))
    await notes.create({ title: 'x' })
    await notes.update(2, { title: 'y' })
    await notes.remove([2])
    await notes.remove([2, 3])
    expect(calls.map(sent)).toEqual([
      { call: 'GET /demo/notes', params: { page: 1 } },
      { call: 'GET /demo/notes/1' },
      { call: 'POST /demo/notes', data: { title: 'x' } },
      { call: 'PUT /demo/notes/2', data: { title: 'y' } },
      { call: 'DELETE /demo/notes/2' },
      { call: 'POST /demo/notes/batch-delete', data: { ids: [2, 3] } },
    ])
  })
})

describe('listParams', () => {
  it('drops empty filters and splits <field>Range into <field>From / <field>To', () => {
    expect(
      listParams({
        page: 2,
        title: '',
        kind: null,
        sort: undefined,
        enabled: 'false',
        createdAtRange: ['2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'],
        updatedAtRange: null,
        doneAtRange: ['', '2026-03-01T00:00:00Z'],
      }),
    ).toEqual({
      page: 2,
      enabled: 'false',
      createdAtFrom: '2026-01-01T00:00:00Z',
      createdAtTo: '2026-02-01T00:00:00Z',
      doneAtTo: '2026-03-01T00:00:00Z',
    })
  })

  it('a date-only range covers both whole days in the local time zone', () => {
    const { createdAtFrom, createdAtTo } = listParams({
      createdAtRange: ['2026-01-01', '2026-01-02'],
    }) as Record<string, string>
    expect(createdAtFrom).toBe(new Date(2026, 0, 1).toISOString())
    expect(createdAtTo).toBe(new Date(2026, 0, 2, 23, 59, 59, 999).toISOString())
  })

  it('sends a <field>Dates range (a date column) as the calendar dates', () => {
    expect(listParams({ publishedOnDates: ['2026-01-01', '2026-01-02'] })).toEqual({
      publishedOnFrom: '2026-01-01',
      publishedOnTo: '2026-01-02',
    })
  })
})

describe('useCrudList', () => {
  const list = (filters = { title: '', enabled: '' }) =>
    useCrudList({ api: notes, filters, sort: '-createdAt' })

  it('loads at once, then search / reset / refresh / sort-change send the shared query', async () => {
    const calls = mockApi({ 'GET /demo/notes': page([1, 2], 45) })
    const l = list()
    expect(l.loading.value).toBe(true)
    await flushPromises()
    expect(l.loading.value).toBe(false)
    expect(l.rows.value.map((r) => r.id)).toEqual([1, 2])
    expect(l.total.value).toBe(45)

    l.query.page = 3
    l.query.title = 'abc'
    await l.search()
    l.query.page = 2
    await l.refresh()
    await l.onSortChange({ prop: 'title', order: 'ascending' })
    await l.onSortChange({ prop: 'title', order: 'descending' })
    await l.onSortChange({ prop: null, order: null })
    expect(l.filtered.value).toBe(true)
    l.query.page = 2
    l.query.enabled = 'true'
    await l.reset()
    expect(l.filtered.value).toBe(false)
    expect(calls.map((c) => c.params)).toEqual([
      { page: 1, pageSize: 20, sort: '-createdAt' },
      { page: 1, pageSize: 20, sort: '-createdAt', title: 'abc' },
      { page: 2, pageSize: 20, sort: '-createdAt', title: 'abc' },
      { page: 1, pageSize: 20, sort: 'title', title: 'abc' },
      { page: 1, pageSize: 20, sort: '-title', title: 'abc' },
      { page: 1, pageSize: 20, sort: '-createdAt', title: 'abc' },
      { page: 1, pageSize: 20, sort: '-createdAt' },
    ])
  })

  it('keeps the latest answer when an older request lands last', async () => {
    const first = later()
    let n = 0
    mockApi({ 'GET /demo/notes': (c) => (n++ ? page([9]) : first.route(c)) })
    const l = list()
    await flushPromises()
    await l.search()
    first.answer(page([1]))
    await flushPromises()
    expect(l.rows.value.map((r) => r.id)).toEqual([9])
    expect(l.loading.value).toBe(false)
  })

  it('goes back to the last page that has rows when the current one came back empty', async () => {
    const reply = { total: 40 }
    const calls = mockApi({
      'GET /demo/notes': (c) =>
        c.params.page === 3 ? page([], reply.total) : page([1], reply.total),
    })
    const l = list()
    await flushPromises()
    l.query.page = 3
    await l.refresh()
    expect(calls.map((c) => c.params.page)).toEqual([1, 3, 2])
    expect(l.query.page).toBe(2)
    expect(l.rows.value).toHaveLength(1)

    // nothing left at all: page 1, no further request
    reply.total = 0
    l.query.page = 3
    await l.refresh()
    expect(calls).toHaveLength(4)
    expect(l.query.page).toBe(1)
    expect(l.rows.value).toEqual([])
  })

  it('remove: confirm → DELETE /:id → message → reload; cancel sends nothing', async () => {
    const calls = mockApi({
      'GET /demo/notes': page([1, 2]),
      'DELETE /demo/notes/1': ok(null),
    })
    const l = list()
    await flushPromises()
    confirm.mockRejectedValueOnce('cancel')
    await expect(l.remove([1])).resolves.toBe(false)
    expect(calls).toHaveLength(1)

    await expect(l.remove([1])).resolves.toBe(true)
    expect(confirm).toHaveBeenLastCalledWith(
      '确定删除这条记录吗？删除后不再显示，也无法在页面上恢复。',
      '提示',
      expect.objectContaining({ type: 'warning', confirmButtonText: '删除' }),
    )
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'get /demo/notes',
      'delete /demo/notes/1',
      'get /demo/notes',
    ])
    expect(success).toHaveBeenCalledWith('删除成功')
  })

  it('batchRemove deletes the selected rows in one request', async () => {
    setLocale('en-US')
    const calls = mockApi({
      'GET /demo/notes': page([1, 2, 3]),
      'POST /demo/notes/batch-delete': ok(null),
    })
    const l = list()
    await flushPromises()
    await expect(l.batchRemove()).resolves.toBe(false)
    l.onSelectionChange([note(1), note(3)])
    await l.batchRemove()
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0]?.[0]).toBe(
      'Delete the 2 selected records? They will no longer be shown and cannot be restored here.',
    )
    expect(calls.map(sent)[1]).toEqual({
      call: 'POST /demo/notes/batch-delete',
      data: { ids: [1, 3] },
    })
    expect(success).toHaveBeenCalledWith('Deleted')
  })

  it('shows the 404 the request layer leaves to callers; 409 is toasted once, by the request layer', async () => {
    mockApi({
      'GET /demo/notes': page([1, 2]),
      'DELETE /demo/notes/1': fail(404, 'A0440', 'not found msg'),
      'DELETE /demo/notes/2': fail(409, 'A0492', 'in use msg'),
    })
    const l = list()
    await flushPromises()
    await expect(l.remove([1])).resolves.toBe(false)
    await expect(l.remove([2])).resolves.toBe(false)
    expect(error.mock.calls).toEqual([
      ['not found msg'],
      [{ message: 'in use msg', grouping: true }],
    ])
    expect(success).not.toHaveBeenCalled()
  })
})

describe('treeApi / useTreeList', () => {
  const topics = treeApi<{ id: number; parentId: number }>('/demo/topics')
  const forest = [{ id: 1, parentId: 0, children: [{ id: 2, parentId: 1, children: [] }] }]

  it('the whole filtered forest (no paging); remove: confirm → DELETE /:id → reload; expand toggles', async () => {
    const calls = mockApi({
      'GET /demo/topics': ok(forest),
      'DELETE /demo/topics/2': ok(null),
    })
    const l = useTreeList({ api: topics, filters: { name: '', enabled: null as string | null } })
    await flushPromises()
    expect(l.rows.value).toEqual(forest)
    expect(l.filtered.value).toBe(false)
    l.query.name = 'x'
    await l.search()
    expect(l.filtered.value).toBe(true)
    await l.reset()
    expect(l.filtered.value).toBe(false)
    confirm.mockRejectedValueOnce('cancel')
    await expect(l.remove(2)).resolves.toBe(false)
    await expect(l.remove(2)).resolves.toBe(true)
    expect(calls.map(sent)).toEqual([
      { call: 'GET /demo/topics', params: {} },
      { call: 'GET /demo/topics', params: { name: 'x' } },
      { call: 'GET /demo/topics', params: {} },
      { call: 'DELETE /demo/topics/2' },
      { call: 'GET /demo/topics', params: {} },
    ])
    expect(success).toHaveBeenCalledWith('删除成功')
    expect(l.expanded.value).toBe(true)
    l.toggleExpand()
    expect(l.expanded.value).toBe(false)
  })
})

describe('useCrudList export', () => {
  it('exportXlsx: GET /export with the filters and sort (no paging), exporting while pending', async () => {
    const file = later()
    const calls = mockApi({
      'GET /demo/notes': page([1]),
      'GET /demo/notes/export': (c) => file.route(c),
    })
    URL.createObjectURL = vi.fn<() => string>(() => 'blob:1')
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const l = useCrudList({ api: notes, filters: { title: '' }, sort: '-createdAt' })
    await flushPromises()
    l.query.title = 'abc'
    l.query.page = 3
    const done = l.exportXlsx('notes.xlsx')
    expect(l.exporting.value).toBe(true)
    await l.exportXlsx('again.xlsx') // ignored while one is running
    await flushPromises()
    file.answer([200, new Blob(['x'])] as never)
    await done
    expect(l.exporting.value).toBe(false)
    expect(click).toHaveBeenCalledOnce()
    expect(calls.slice(1).map(sent)).toEqual([
      { call: 'GET /demo/notes/export', params: { sort: '-createdAt', title: 'abc' } },
    ])
  })
})

describe('useCrudForm', () => {
  type Model = { title: string; email: string; quantity: number | null }
  const emptyModel = (): Model => ({ title: '', email: '', quantity: null })

  /** A dialog content component over the form state: `id` = edit, none = add. */
  function setup(id?: number) {
    let form!: ReturnType<typeof useCrudForm<Note, Model>>
    const Form = defineComponent({
      props: { id: { type: Number, default: undefined } },
      emits: ['done', 'cancel'],
      setup(props, { emit }) {
        form = useCrudForm<Note, Model>({
          api: notes,
          schema: DemoNoteCreate,
          emptyModel,
          id: props.id,
          emit,
        })
        const { model, formRef, rules } = form
        const item = (prop: keyof Model) =>
          h(ElFormItem, { prop, label: prop }, () =>
            h(ElInput, {
              modelValue: model[prop] ?? '',
              'onUpdate:modelValue': (v: string) =>
                ((model as Record<string, unknown>)[prop] = prop === 'quantity' ? Number(v) : v),
            }),
          )
        return () =>
          h(ElForm, { ref: formRef, model, rules }, () =>
            (['title', 'email', 'quantity'] as const).map(item),
          )
      },
    })
    const wrapper = mount(Form, { props: { id }, global: { plugins: [ElementPlus, i18n] } })
    const errors = () => wrapper.findAll('.el-form-item__error').map((e) => e.text())
    return { form, wrapper, errors }
  }

  it('add: validates with the shared schema, POSTs once while pending, emits done with the new id', async () => {
    const post = later()
    const calls = mockApi({ 'POST /demo/notes': post.route })
    const { form, wrapper, errors } = setup()
    expect({ ...form.model }).toEqual(emptyModel())

    await form.submit()
    await vi.waitFor(() =>
      expect(errors()).toEqual(['标题至少 3 个字符', '邮箱不是有效的邮箱地址', '数量不能为空']),
    )
    expect(calls).toHaveLength(0)

    Object.assign(form.model, { title: 'hello', email: 'a@b.co', quantity: 3 })
    const submitting = form.submit()
    await flushPromises()
    expect(form.submitting.value).toBe(true)
    await form.submit() // a second click while pending sends nothing
    post.answer(ok(note(7)))
    await submitting
    expect(calls.map(sent)).toEqual([
      { call: 'POST /demo/notes', data: { title: 'hello', email: 'a@b.co', quantity: 3 } },
    ])
    expect(form.submitting.value).toBe(false)
    expect(success).toHaveBeenCalledWith('新增成功')
    expect(wrapper.emitted('done')).toEqual([
      [{ title: 'hello', email: 'a@b.co', quantity: 3, id: 7 }],
    ])
  })

  it('add: done also carries what else the POST answer holds (a one-time secret); the form values win', async () => {
    mockApi({ 'POST /demo/notes': ok({ ...note(8), secret: 's3cr3t' }) })
    const { form, wrapper } = setup()
    Object.assign(form.model, { title: 'hello', email: 'a@b.co', quantity: 3 })
    await form.submit()
    expect(wrapper.emitted('done')).toEqual([
      [{ title: 'hello', email: 'a@b.co', quantity: 3, id: 8, secret: 's3cr3t' }],
    ])
  })

  it('edit: loads GET /:id, copies only the model fields, PUTs them, emits done', async () => {
    const calls = mockApi({
      'GET /demo/notes/5': ok({ ...note(5), createdAt: '2026-01-01T00:00:00.000Z' }),
      'PUT /demo/notes/5': ok(null),
    })
    const { form, wrapper } = setup(5)
    expect(form.loading.value).toBe(true)
    await flushPromises()
    expect({ ...form.model }).toEqual({ title: 'note 5', email: 'a@b.co', quantity: 5 })
    expect(form.loading.value).toBe(false)
    form.model.title = 'renamed'
    await form.submit()
    expect(calls.map(sent)[1]).toEqual({
      call: 'PUT /demo/notes/5',
      data: { title: 'renamed', email: 'a@b.co', quantity: 5 },
    })
    expect(success).toHaveBeenCalledWith('保存成功')
    expect(wrapper.emitted('done')).toEqual([
      [{ title: 'renamed', email: 'a@b.co', quantity: 5, id: 5 }],
    ])
  })

  it('edit of a seeded name (an i18n key): shows its text, sends the key back unless it changed', async () => {
    const key = 'seed.position.engLead'
    expect(i18n.global.te(key)).toBe(true) // seed texts come from packages/shared/src/i18n
    const calls = mockApi({
      'GET /demo/notes/6': ok({ ...note(6), title: key }),
      'PUT /demo/notes/6': ok(null),
    })
    const { form, wrapper } = setup(6)
    await flushPromises()
    expect(form.model.title).toBe(i18n.global.t(key))
    await form.submit()
    expect(calls.map(sent)[1]).toEqual({
      call: 'PUT /demo/notes/6',
      data: { title: key, email: 'a@b.co', quantity: 6 },
    })
    expect(wrapper.emitted('done')).toEqual([[{ title: key, email: 'a@b.co', quantity: 6, id: 6 }]])

    form.model.title = `${i18n.global.t(key)} 2`
    await form.submit()
    expect(calls.map(sent)[2]?.data).toEqual({
      title: `${i18n.global.t(key)} 2`,
      email: 'a@b.co',
      quantity: 6,
    })
  })

  it('add: a field left undefined (a DB expression default) passes the rules and is not sent', async () => {
    type Event = { id: number; title: string; startsAt: string }
    type EventModel = { title: string; startsAt?: string }
    const events = crudApi<Event, EventModel>('/demo/events')
    const calls = mockApi({ 'POST /demo/events': ok({ id: 3, title: 'x', startsAt: 'now' }) })
    const submitted = async (startsAt: undefined | null) => {
      let form!: ReturnType<typeof useCrudForm<Event, EventModel>>
      const Form = defineComponent({
        emits: ['done', 'cancel'],
        setup(_, { emit }) {
          // the generated form's empty value of such a column (crud.ts webOf): undefined, not null
          form = useCrudForm<Event, EventModel>({
            api: events,
            schema: DemoEventCreate,
            emptyModel: () => ({ title: '', startsAt }),
            emit,
          })
          const { model, formRef, rules } = form
          return () =>
            h(ElForm, { ref: formRef, model, rules }, () =>
              (['title', 'startsAt'] as const).map((prop) =>
                h(ElFormItem, { prop, label: prop }, () => h(ElInput, { modelValue: model[prop] })),
              ),
            )
        },
      })
      const wrapper = mount(Form, { global: { plugins: [ElementPlus, i18n] } })
      form.model.title = 'launch'
      await form.submit()
      await flushPromises()
      return () => wrapper.findAll('.el-form-item__error').map((e) => e.text())
    }
    expect((await submitted(undefined))()).toEqual([])
    expect(calls.map(sent)).toEqual([{ call: 'POST /demo/events', data: { title: 'launch' } }])
    // null (the old empty value) is refused by the schema that only allows leaving it out
    const errors = await submitted(null)
    await vi.waitFor(() => expect(errors()).toEqual(['startsAt不能为空']))
    expect(calls).toHaveLength(1)
  })

  it('edit of a row gone meanwhile (404): shows the message and cancels; a failed save stays', async () => {
    mockApi({
      'GET /demo/notes/5': fail(404, 'A0440', 'not found msg'),
      'POST /demo/notes': fail(409, 'A0491', 'duplicate msg'),
    })
    const gone = setup(5)
    await flushPromises()
    expect(error).toHaveBeenCalledWith('not found msg')
    expect(gone.wrapper.emitted('cancel')).toHaveLength(1)

    const { form, wrapper } = setup()
    Object.assign(form.model, { title: 'hello', email: 'a@b.co', quantity: 3 })
    await form.submit()
    expect(error).toHaveBeenLastCalledWith({ message: 'duplicate msg', grouping: true })
    expect(form.submitting.value).toBe(false)
    expect(wrapper.emitted('done')).toBeUndefined()
    expect(wrapper.emitted('cancel')).toBeUndefined()
  })
})

const DICT = {
  version: 1,
  entries: [
    { value: 'true', label: 'x', labelI18n: { 'zh-CN': '启用', 'en-US': 'Enabled' } },
    { value: 'false', label: 'Off', labelI18n: null },
  ].map((e, i) => ({ ...e, tagType: null, cssClass: null, isDefault: false, sortNo: i })),
}

describe('useDict / DictSelect', () => {
  it('lists localized options and labels, following the locale', async () => {
    const calls = mockApi({ 'GET /settings/dicts/core.enabled/entries': ok(DICT) })
    const d = useDict('core.enabled')
    expect(d.options.value).toEqual([])
    await flushPromises()
    expect(d.options.value).toEqual([
      { value: 'true', label: '启用' },
      { value: 'false', label: 'Off' },
    ])
    expect(d.label(true)).toBe('启用')
    setLocale('en-US')
    expect(d.options.value[0]).toEqual({ value: 'true', label: 'Enabled' })
    expect(useDict('core.enabled').label('false')).toBe('Off')
    expect(calls).toHaveLength(1)
  })

  it('DictSelect offers the entries and binds the value', async () => {
    mockApi({ 'GET /settings/dicts/core.enabled/entries': ok(DICT) })
    const wrapper = mount(DictSelect, {
      props: { code: 'core.enabled', modelValue: 'false' },
      global: { plugins: [ElementPlus, i18n, createPinia()] },
      attachTo: document.body,
    })
    await flushPromises()
    expect(wrapper.text()).toContain('Off')
    const options = document.body.querySelectorAll('.el-select-dropdown__item')
    expect([...options].map((o) => o.textContent)).toEqual(['启用', 'Off'])
    ;(options[0] as HTMLElement).click()
    await nextTick()
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['true'])
    wrapper.unmount()
  })
})

describe('Pagination', () => {
  it('two-way binds page / pageSize and emits one change per user action', async () => {
    const wrapper = mount(Pagination, {
      props: {
        page: 3,
        pageSize: 20,
        total: 100,
        'onUpdate:page': (v: number) => wrapper.setProps({ page: v }),
        'onUpdate:pageSize': (v: number) => wrapper.setProps({ pageSize: v }),
      },
      global: { plugins: [ElementPlus, i18n] },
    })
    const ep = wrapper.findComponent(ElPagination)
    ep.vm.$emit('update:current-page', 4)
    ep.vm.$emit('current-change', 4)
    await flushPromises()
    expect(wrapper.props('page')).toBe(4)
    expect(wrapper.emitted('change')).toHaveLength(1)

    // a larger page size moves the page into range too: still one change
    ep.vm.$emit('update:page-size', 50)
    ep.vm.$emit('size-change', 50)
    ep.vm.$emit('update:current-page', 2)
    ep.vm.$emit('current-change', 2)
    await flushPromises()
    expect([wrapper.props('page'), wrapper.props('pageSize')]).toEqual([2, 50])
    expect(wrapper.emitted('change')).toHaveLength(2)
  })
})

describe('TableToolbar', () => {
  const toolbar = (tableId: string) =>
    mount(TableToolbar, {
      props: { tableId },
      slots: { default: '<button class="create">create</button>' },
      global: { plugins: [ElementPlus, i18n] },
    })

  it('toggles the search form and asks for a refresh', async () => {
    const wrapper = toolbar('demo.note')
    expect(wrapper.find('.create').exists()).toBe(true)
    // column settings only with the table's columns (table-prefs.spec)
    expect(wrapper.find('button[aria-label="列设置"]').exists()).toBe(false)
    await wrapper.get('button[aria-label="显示或隐藏搜索"]').trigger('click')
    expect(wrapper.emitted('update:search')).toEqual([[false]])
    await wrapper.get('button[aria-label="刷新"]').trigger('click')
    expect(wrapper.emitted('refresh')).toHaveLength(1)
  })
})
