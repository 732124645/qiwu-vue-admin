// The form builder (see docs/design-notes.md#workflow) exports the sanitized schema as JSON and as our small Vue SFC,
// shown in CodeViewer (copy) with a download; a form the whitelist rejects says why instead.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { compileScript, parse } from 'vue/compiler-sfc'
import ElementPlus, { ElMessage } from 'element-plus'
import FcDesigner from '@form-create/designer'
import { sanitizeFormSchema, type FormSchema } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import FormDesigner from '@/views/platform/formkit/FormDesigner.vue'
import FormExport from '@/views/platform/formkit/FormExport.vue'
import { formFiles } from '@/views/platform/formkit/export'

const openDialog = vi.hoisted(() =>
  vi.fn<(c: unknown, props: { schema: FormSchema }, options: { title: () => string }) => void>(),
)
vi.mock('@/core/dialog', () => ({ openDialog }))
const saveBlob = vi.hoisted(() => vi.fn<(blob: Blob, name: string) => void>())
vi.mock('@/core/request/http', async (orig) => ({
  ...(await orig<typeof import('@/core/request/http')>()),
  saveBlob,
}))
vi.mock('@/api/platform/settings/dict', () => ({ dictApi: { options: async () => [] } }))

// a title that would end a script block, were it pasted as it is
const TITLE = 'Reason </script><script>alert(1)</script>'
const SCHEMA: FormSchema = {
  rule: [
    { type: 'input', field: 'reason', title: TITLE, $required: true },
    { type: 'qw-user-select', field: 'approver', title: 'Approver' },
  ],
  option: { form: { labelWidth: '120px' }, submitBtn: { show: true, innerText: 'Send' } },
} as FormSchema

beforeEach(() => {
  setLocale('en-US')
  openDialog.mockReset()
  saveBlob.mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('formFiles', () => {
  const [json, vue] = formFiles(SCHEMA)

  it('form.json: the schema as it is', () => {
    expect(json!.path).toBe('form.json')
    expect(JSON.parse(json!.content)).toEqual(SCHEMA)
  })

  it('form.vue: a component that compiles, rendering the same rule and option', () => {
    expect(vue!.path).toBe('form.vue')
    const { descriptor, errors } = parse(vue!.content)
    expect(errors).toEqual([])
    expect(descriptor.template?.content.trim()).toBe(
      '<form-create v-model="data" :rule="rule" :option="option" :locale="formLocale" />',
    )
    // the title cannot end the script block: the whole rule sits in it, `<` escaped
    expect(vue!.content).not.toContain('</script><script>')
    const script = descriptor.scriptSetup!.content
    const literal = (name: string) =>
      JSON.parse(new RegExp(`const ${name} = ref\\(([\\s\\S]*?)\\)\\n`).exec(script)![1]!)
    expect(literal('rule')).toEqual(SCHEMA.rule)
    expect(literal('option')).toEqual(SCHEMA.option)
    expect(script).toContain("import { installFormCreate } from '@/views/platform/formkit/widgets'")
    // template and script compile together
    expect(compileScript(descriptor, { id: 'form', inlineTemplate: true }).content).toContain(
      '_component_form_create',
    )
  })

  it('no option: an empty one', () => {
    expect(formFiles({ rule: [] } as unknown as FormSchema)[1]!.content).toContain(
      'const option = ref({})',
    )
  })
})

describe('FormExport', () => {
  it('shows both files; download saves the shown one; close cancels', async () => {
    const w = mount(FormExport, {
      props: { schema: SCHEMA },
      global: { plugins: [ElementPlus, i18n] },
      attachTo: document.body,
    })
    const nodes = w.findAll('.el-tree-node__content')
    expect(nodes.map((n) => n.text())).toEqual(['form.json', 'form.vue'])
    const button = (text: string) => w.findAll('button').find((b) => b.text() === text)!

    await button('Download').trigger('click')
    expect(saveBlob).toHaveBeenLastCalledWith(expect.any(Blob), 'form.json')
    await nodes[1]!.trigger('click')
    await flushPromises()
    await button('Download').trigger('click')
    const [blob, name] = saveBlob.mock.lastCall!
    expect(name).toBe('form.vue')
    expect(await blob.text()).toBe(formFiles(SCHEMA)[1]!.content)

    await button('Close').trigger('click')
    expect(w.emitted('cancel')).toHaveLength(1)
  })
})

describe('FormDesigner export', () => {
  async function designer(rule: unknown[]) {
    const w = mount(FormDesigner, { global: { plugins: [ElementPlus, i18n] } })
    await flushPromises()
    w.findComponent(FcDesigner).vm.setRule(rule as never)
    await flushPromises()
    await w
      .findAll('._fc-m-tools-r button')
      .find((b) => b.text() === 'Export')!
      .trigger('click')
    return w
  }

  it('opens the sanitized schema in FormExport', async () => {
    const w = await designer(SCHEMA.rule)
    expect(openDialog).toHaveBeenCalledTimes(1)
    const [component, props, options] = openDialog.mock.lastCall!
    expect(component).toBe(FormExport)
    expect(options.title()).toBe('Export form code')
    // what the whitelist keeps (with the designer's inert ids, so it loads back), and it passes again
    expect(props.schema.rule).toMatchObject(SCHEMA.rule)
    expect(sanitizeFormSchema(props.schema)).toEqual({ ok: true, schema: props.schema })
    w.unmount()
  })

  it('a form the whitelist rejects: the reason, no dialog', async () => {
    const error = vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
    const w = await designer([{ type: 'fcRow', children: [] }])
    expect(openDialog).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(
      'The form cannot be exported: Forms cannot use the component "fcRow"',
    )
    w.unmount()
  })
})
