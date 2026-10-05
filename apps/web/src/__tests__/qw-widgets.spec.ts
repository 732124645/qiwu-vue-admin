// Our form-create components (views/platform/formkit/widgets.ts) render the existing
// pickers through form-create, with the values a process form keeps; the e2e formkit-widgets.spec.ts
// covers the designer side. The calc components show what shared form-calc gives.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick, ref, shallowRef } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElDatePicker, ElInputNumber } from 'element-plus'
import { sanitizeFormSchema, storageRefs, type FsObjectVo } from '@qiwu/shared'
import AreaCascader from '@/core/components/AreaCascader.vue'
import DeptTreeSelect from '@/core/components/DeptTreeSelect.vue'
import DictSelect from '@/core/components/DictSelect.vue'
import FileUpload from '@/core/components/FileUpload.vue'
import UserSelect from '@/core/components/UserSelect.vue'
import { i18n, setLocale } from '@/core/i18n'
import formCreate from '@/views/platform/formkit/widgets'
import { mockApi, ok } from './mock-api'

const entry = (value: string) => ({
  value,
  label: value,
  labelI18n: null,
  tagType: null,
  cssClass: null,
  isDefault: false,
  sortNo: 0,
})
const routes = () => ({
  // process forms pick from every enabled dept, not the caller's data scope
  'GET /wf/depts/options': ok([{ id: 3, name: 'HQ', children: [] }]),
  'GET /geo/areas/tree': ok([]),
  'GET /settings/dicts/iam.gender/entries': ok({ version: 1, entries: [entry('male')] }),
  'GET /settings/dicts/wf.category/entries': ok({ version: 1, entries: [entry('hr')] }),
})

interface Api {
  formData(): Record<string, unknown>
  setValue(field: string, value: unknown): void
  mergeRule(field: string, rule: Record<string, unknown>): void
}
let api: Api
const wrappers: VueWrapper[] = []

/**
 * form-create (with our components) over `rule`, after sanitizeFormSchema as a renderer does; `plain`: the
 * rules as a page holding its schema in a shallowRef passes them (the process start page); `form`: more
 * props of the renderer (its values as a page passes them, the option, …)
 */
async function render(rule: unknown[], plain = false, form: Record<string, unknown> = {}) {
  const result = sanitizeFormSchema({ rule })
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  // reactive, as a page holds it: form-create re-renders on value and prop changes
  const rules = plain ? shallowRef(result.schema.rule) : ref(result.schema.rule)
  const Form = formCreate.$form()
  const Host = defineComponent({
    setup: () => () =>
      h(Form, {
        rule: rules.value,
        option: { submitBtn: false, resetBtn: false },
        'onUpdate:api': (a: Api) => (api = a),
        ...form,
      }),
  })
  const w = mount(Host, { global: { plugins: [ElementPlus, i18n] }, attachTo: document.body })
  wrappers.push(w)
  await flushPromises()
  return w
}

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
})
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount())
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('qw-* form-create components', () => {
  it('render the existing pickers with the rule props, form-create inject kept off the DOM', async () => {
    mockApi(routes())
    const w = await render([
      { type: 'qw-user-select', field: 'approver', props: { disabled: true } },
      { type: 'qw-dept-select', field: 'dept', props: { placeholder: 'Pick one' } },
      { type: 'qw-dict-select', field: 'gender', props: { code: 'iam.gender', multiple: true } },
      { type: 'qw-upload', field: 'files', props: { limit: 2, maxSize: 3, accept: '.pdf' } },
      { type: 'qw-area-select', field: 'region', props: { clearable: true } },
    ])
    // the user picker lists every user (the wf source) and honours `disabled`
    const user = w.findComponent(UserSelect)
    expect(user.props()).toMatchObject({ source: 'wf', disabled: true })
    expect(user.find('button').attributes()).toHaveProperty('disabled')
    const dept = w.findComponent(DeptTreeSelect)
    expect(dept.props('source')).toBe('wf')
    expect(dept.vm.$attrs.placeholder).toBe('Pick one')
    const dict = w.findComponent(DictSelect)
    expect(dict.props('code')).toBe('iam.gender')
    expect(dict.vm.$attrs.multiple).toBe(true)
    // private workflow attachments; maxSize in MB
    expect(w.findComponent(FileUpload).props()).toMatchObject({
      bizTag: 'wf.attachment',
      limit: 2,
      maxSize: 3 * 1024 * 1024,
      accept: '.pdf',
    })
    expect(w.findComponent(AreaCascader).exists()).toBe(true)
    expect(document.body.innerHTML).not.toMatch(/formcreateinject/i)
  })

  it('qw-dict-select follows its code and loads nothing without one', async () => {
    const calls = mockApi(routes())
    const w = await render([{ type: 'qw-dict-select', field: 'kind' }])
    expect(w.findComponent(DictSelect).exists()).toBe(true)
    expect(calls.filter((c) => c.url?.startsWith('/settings/dicts'))).toEqual([])

    api.mergeRule('kind', { props: { code: 'wf.category' } })
    await flushPromises()
    expect(calls.map((c) => c.url)).toContain('/settings/dicts/wf.category/entries')
    api.setValue('kind', 'hr')
    await flushPromises()
    expect(api.formData()).toEqual({ kind: 'hr' })
  })

  it('qw-upload keeps a `<id>/<file name>` line per file: no URL or other field gets in', async () => {
    mockApi(routes())
    const w = await render([{ type: 'qw-upload', field: 'files' }])
    const upload = () => w.findComponent(FileUpload)

    // not a string (someone else sent it): no file, no render error
    api.setValue('files', [7, { id: 8, url: 'javascript:alert(1)' }])
    await flushPromises()
    expect(upload().props('modelValue')).toEqual([])

    // a crafted value: only the well-formed lines survive, without a URL
    api.setValue('files', '7/a.pdf\njavascript:alert(1)\n')
    await flushPromises()
    const shown = upload().props('modelValue') as FsObjectVo[]
    expect(shown).toMatchObject([{ id: 7, originalName: 'a.pdf', url: null, isPublic: false }])
    expect(w.find('a').exists()).toBe(false) // a private file downloads by id (a button), no link

    // an upload appends its line (the value storageRefs reads on start); removing drops it
    upload().vm.$emit('update:modelValue', [
      ...shown,
      { ...shown[0]!, id: 9, originalName: 'b 1.png', url: 'https://x/b.png' },
    ])
    await nextTick()
    expect(api.formData()).toEqual({ files: '7/a.pdf\n9/b 1.png' })
    expect(storageRefs(api.formData().files)).toEqual([
      { id: 7, name: 'a.pdf' },
      { id: 9, name: 'b 1.png' },
    ])
    await w.find('.file-upload__item .icon-button').trigger('click')
    expect(api.formData()).toEqual({ files: '9/b 1.png' })
  })

  it('the clear and pick of qw-user-select give the user id, null once cleared', async () => {
    mockApi(routes())
    const w = await render([{ type: 'qw-user-select', field: 'approver', value: 5 }])
    expect(w.find('input').element.value).toBe('#5')
    await w.find('.user-select__clear').trigger('click')
    expect(api.formData()).toEqual({ approver: null })
    // `pick` (UserPicker dialog) is covered by user-picker.spec.ts; the id lands in the form data
    w.findComponent(UserSelect).vm.$emit('update:modelValue', 6)
    await nextTick()
    expect(api.formData()).toEqual({ approver: 6 })
  })
})

describe('calc components', () => {
  const half = (field: string) => ({
    type: 'radio',
    field,
    options: [
      { label: 'AM', value: 'am' },
      { label: 'PM', value: 'pm' },
    ],
  })

  it('qw-date-range-days keeps the days its date fields give as its value, read-only', async () => {
    mockApi(routes())
    const w = await render([
      { type: 'datePicker', field: 'start' },
      half('startHalf'),
      { type: 'datePicker', field: 'end' },
      half('endHalf'),
      {
        type: 'qw-date-range-days',
        field: 'days',
        props: {
          startField: 'start',
          endField: 'end',
          startHalfField: 'startHalf',
          endHalfField: 'endHalf',
        },
      },
    ])
    const days = () => w.find('.el-input-group input').element as HTMLInputElement
    expect(days().value).toBe('')
    expect(days().readOnly).toBe(true)
    expect(w.find('.el-input-group__append').text()).toBe('days')

    const set = async (values: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(values)) api.setValue(k, v)
      await flushPromises()
      return { shown: days().value, value: api.formData().days }
    }
    expect(await set({ start: '2026-10-01', end: '2026-10-03' })).toEqual({ shown: '3', value: 3 })
    expect(await set({ startHalf: 'pm', endHalf: 'am' })).toEqual({ shown: '2', value: 2 })
    // a value typed in (or sent) is put back
    expect(await set({ days: 40 })).toEqual({ shown: '2', value: 2 })
    // end before start: no days
    expect(await set({ end: '2026-09-30' })).toEqual({ shown: '', value: null })
  })

  it('qw-date-range-days disabled (a read-only reader): the days it was given, not recomputed', async () => {
    mockApi(routes())
    const w = await render(
      [
        { type: 'datePicker', field: 'start' },
        { type: 'datePicker', field: 'end' },
        {
          type: 'qw-date-range-days',
          field: 'days',
          props: { startField: 'start', endField: 'end', disabled: true },
        },
      ],
      false,
      { modelValue: { start: '2026-10-01', end: '2026-10-03', days: 2.5 } },
    )
    expect((w.find('.el-input-group input').element as HTMLInputElement).value).toBe('2.5')
    expect(api.formData().days).toBe(2.5)
  })

  it('qw-date-range-days follows dates picked in a form over plain rules (its change events)', async () => {
    mockApi(routes())
    const day = (field: string) => ({
      type: 'datePicker',
      field,
      props: { type: 'date', valueFormat: 'YYYY-MM-DD' },
    })
    const w = await render(
      [
        day('start'),
        day('end'),
        {
          type: 'qw-date-range-days',
          field: 'days',
          props: { startField: 'start', endField: 'end' },
        },
      ],
      true,
    )
    const [start, end] = w.findAllComponents(ElDatePicker)
    start!.vm.$emit('update:modelValue', '2026-10-12')
    end!.vm.$emit('update:modelValue', '2026-10-15')
    await flushPromises()
    expect((w.find('.el-input-group input').element as HTMLInputElement).value).toBe('4')
    expect(api.formData().days).toBe(4)
  })

  const columns = [
    { prop: 'item', label: 'Item' },
    { prop: 'amount', label: 'Amount', sum: 'total' },
  ]
  const footer = (w: VueWrapper) => w.findAll('.el-table__footer td').map((td) => td.text())

  it('qw-detail-table: rows as JSON text, number cells where a total is named, totals in the summary', async () => {
    mockApi(routes())
    const w = await render([{ type: 'qw-detail-table', field: 'items', props: { columns } }])
    api.setValue(
      'items',
      JSON.stringify([
        { item: 'Taxi', amount: 12.5 },
        { amount: 0.1, x: 1 },
      ]),
    )
    await flushPromises()
    expect(footer(w)).toEqual(['Total', '12.6', ''])
    const numbers = w.findAllComponents(ElInputNumber)
    expect(numbers).toHaveLength(2)

    // a cell edit sends every row (the server keeps the columns only and recomputes the total)
    numbers[1]!.vm.$emit('update:modelValue', 0.2)
    await flushPromises()
    expect(JSON.parse(api.formData().items as string)).toEqual([
      { item: 'Taxi', amount: 12.5 },
      { amount: 0.2 },
    ])
    expect(footer(w)).toEqual(['Total', '12.7', ''])

    // a new row waits for its cells; removing one sends the rest, removing all leaves no value
    await w
      .findAll('button')
      .find((b) => b.text() === 'Add a row')!
      .trigger('click')
    expect(w.findAllComponents(ElInputNumber)).toHaveLength(3)
    const remove = () => w.findAll('button').filter((b) => b.text() === 'Remove')
    await remove()[0]!.trigger('click')
    expect(JSON.parse(api.formData().items as string)).toEqual([{ amount: 0.2 }, {}])
    await remove()[1]!.trigger('click')
    await remove()[0]!.trigger('click')
    expect(api.formData().items).toBeNull()
    expect(footer(w)).toEqual(['Total', '0', ''])
  })

  it('qw-detail-table: each cell and row button named by its column and row', async () => {
    mockApi(routes())
    const w = await render([
      {
        type: 'qw-detail-table',
        field: 'items',
        value: JSON.stringify([{ item: 'Taxi', amount: 1 }, { item: 'Hotel' }]),
        props: { columns },
      },
    ])
    const names = (s: string) => w.findAll(s).map((e) => e.attributes('aria-label'))
    expect(names('.el-table__body input')).toEqual([
      'Item, row 1',
      'Amount, row 1',
      'Item, row 2',
      'Amount, row 2',
    ])
    expect(names('.el-table__body button')).toEqual(['Remove row 1', 'Remove row 2'])
  })

  it('qw-detail-table disabled shows the cells as text, with no editing', async () => {
    mockApi(routes())
    const value = JSON.stringify([{ item: '<b>Hotel</b>', amount: 300 }])
    const w = await render([
      { type: 'qw-detail-table', field: 'items', value, props: { columns, disabled: true } },
    ])
    expect(w.findAll('.el-table__body td').map((td) => td.text())).toEqual(['<b>Hotel</b>', '300'])
    expect(w.find('.el-table__body b').exists()).toBe(false)
    expect(w.findAll('input')).toHaveLength(0)
    expect(w.findAll('button')).toHaveLength(0)
    expect(footer(w)).toEqual(['Total', '300'])
  })
})
