// docs/adr/003-validation.md: the same shared zod schema the server validates with drives an el-form,
// with the same shared i18n messages as the server's 400 errors.
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h, reactive, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus, {
  ElForm,
  ElFormItem,
  ElInput,
  ElInputNumber,
  type FormInstance,
} from 'element-plus'
import { createI18n, useI18n } from 'vue-i18n'
import { changePasswordBody, DEFAULT_PASSWORD_POLICY, positionCreate } from '@qiwu/shared'
import { DemoNoteCreate } from '@qiwu/shared/testing'
import { sharedMessages, zodRules } from '@/core/form/zod-rules'

const NoteForm = defineComponent({
  setup(_, { expose }) {
    const i18n = useI18n()
    const model = reactive<{ title: string; email: string; quantity?: number | null }>({
      title: '',
      email: '',
    })
    const form = ref<FormInstance>()
    const rules = zodRules(DemoNoteCreate, i18n)
    expose({ model, validate: () => form.value!.validate().catch(() => false) })
    const item = (prop: 'title' | 'email') =>
      h(ElFormItem, { prop, label: i18n.t(`field.demo.${prop}`) }, () =>
        h(ElInput, {
          modelValue: model[prop],
          'onUpdate:modelValue': (v: string) => (model[prop] = v),
        }),
      )
    return () =>
      h(ElForm, { ref: form, model, rules }, () => [
        item('title'),
        item('email'),
        h(ElFormItem, { prop: 'quantity', label: i18n.t('field.demo.quantity') }, () =>
          h(ElInputNumber, {
            modelValue: model.quantity ?? undefined,
            'onUpdate:modelValue': (v?: number | null) => (model.quantity = v),
          }),
        ),
      ])
  },
})

function setup() {
  const i18n = createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: sharedMessages,
  })
  const wrapper = mount(NoteForm, { global: { plugins: [ElementPlus, i18n] } })
  const vm = wrapper.vm as unknown as {
    model: { title: string; email: string; quantity?: number | null }
    validate: () => Promise<boolean>
  }
  const errors = () => wrapper.findAll('.el-form-item__error').map((e) => e.text())
  return { i18n, wrapper, vm, errors }
}

describe('shared zod schema → el-form rules', () => {
  it('shows the translated messages for invalid input, following the locale', async () => {
    const { i18n, vm, errors } = setup()
    Object.assign(vm.model, { title: ' ab ', email: 'nope' })
    expect(await vm.validate()).toBe(false)
    // identical to the server's 400 errors[] for the same input (core-zod-pipe.e2e-spec.ts);
    // el-form-item shows errors after a 100 ms debounce
    await vi.waitFor(() =>
      expect(errors()).toEqual(['标题至少 3 个字符', '邮箱不是有效的邮箱地址', '数量不能为空']),
    )

    i18n.global.locale.value = 'en-US'
    expect(await vm.validate()).toBe(false)
    await vi.waitFor(() =>
      expect(errors()).toEqual([
        'Title must be at least 3 characters',
        'Email must be a valid email address',
        'Quantity is required',
      ]),
    )
  })

  it('passes valid input', async () => {
    const { vm, errors } = setup()
    Object.assign(vm.model, { title: 'Hello', email: 'a@b.co', quantity: 3 })
    expect(await vm.validate()).toBe(true)
    await flushPromises()
    expect(errors()).toEqual([])
  })
})

describe('zodRules required flag (the asterisk)', () => {
  it('marks fields that accept neither undefined nor an empty string', () => {
    const i18n = createI18n({ legacy: false, locale: 'en-US', messages: sharedMessages })
    const required = (schema: Parameters<typeof zodRules>[0]) =>
      Object.fromEntries(
        Object.entries(zodRules(schema, i18n.global)).map(([k, [r]]) => [k, r?.required]),
      )
    expect(required(DemoNoteCreate)).toEqual({ title: true, email: true, quantity: true })
    expect(required(positionCreate)).toEqual({
      code: true,
      name: true,
      sortNo: false,
      enabled: false,
      note: false,
    })
  })
})

describe('zodRules with the form model', () => {
  it('also reports object-level refinements on their path (new password ≠ old)', async () => {
    const i18n = createI18n({ legacy: false, locale: 'en-US', messages: sharedMessages })
    const model = { oldPassword: 'Same-pass1', newPassword: 'Same-pass1' }
    const rules = zodRules(changePasswordBody(DEFAULT_PASSWORD_POLICY), i18n.global, model)
    const check = (prop: 'oldPassword' | 'newPassword', value: string) =>
      new Promise<string | undefined>((resolve) => {
        const rule = rules[prop]![0]!
        const done = (e?: string | Error) => resolve(e instanceof Error ? e.message : e)
        void rule.validator!(rule, value, done, {}, {})
      })
    expect(await check('newPassword', 'Same-pass1')).toBe(
      'The new password must differ from the old one',
    )
    expect(await check('newPassword', 'short')).toBe('New password must be at least 8 characters')
    expect(await check('newPassword', 'Other-pass2')).toBeUndefined()
    expect(await check('oldPassword', 'Same-pass1')).toBeUndefined()
  })
})
