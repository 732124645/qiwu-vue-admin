import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent } from 'vue'
import ElementPlus, { ElMessage } from 'element-plus'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import LeaveForm from '@/views/biz/leave/form.vue'
import { mockApi, ok } from './mock-api'

const picker = defineComponent({
  name: 'WfUserIds',
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template:
    '<button class="choose-reviewer" @click="$emit(\'update:modelValue\', [7])">Choose reviewer</button>',
})
let form: VueWrapper
let calls: ReturnType<typeof mockApi>

async function open(picks: object[]) {
  calls = mockApi({
    'GET /wf/models/leave/start-info': ok({ schema: null, picks }),
    'GET /settings/dicts/biz.leave_kind/entries': ok({ version: 1, entries: [] }),
    'POST /biz/leaves': ok({ id: 5, instanceId: 11 }),
  })
  form = mount(LeaveForm, {
    global: { plugins: [ElementPlus, i18n], stubs: { WfUserIds: picker } },
    attachTo: document.body,
  })
  await flushPromises()
  const vm = form.vm as unknown as { model: Record<string, unknown> }
  Object.assign(vm.model, {
    leaveKind: 'annual',
    startAt: '2026-10-22T01:00:00Z',
    endAt: '2026-10-23T01:00:00Z',
    days: 2,
    reason: 'Appointment',
  })
  await flushPromises()
}
const submit = () =>
  form.findAll('button').find((button) => button.text() === i18n.global.t('biz.leave.submit'))!
const posted = () => calls.filter((call) => call.method === 'post' && call.url === '/biz/leaves')

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
})
afterEach(() => {
  form?.unmount()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('leave request form', () => {
  it('requires the workflow selected reviewer and sends the selected user IDs with the request', async () => {
    await open([{ id: 'review', name: 'Reviewer', type: 'review' }])
    await submit().trigger('click')
    await flushPromises()
    expect(posted()).toHaveLength(0)
    await vi.waitFor(() => expect(form.find('.el-form-item__error').exists()).toBe(true))
    await form.find('.choose-reviewer').trigger('click')
    await submit().trigger('click')
    await vi.waitFor(() => expect(posted()).toHaveLength(1))
    expect(JSON.parse(posted()[0]!.data).initiatorPicks).toEqual({ review: [7] })
    expect(form.emitted('done')?.[0]).toMatchObject([{ id: 5 }])
  })

  it('keeps an existing model without initiator-pick steps usable', async () => {
    await open([])
    expect(form.find('.choose-reviewer').exists()).toBe(false)
    await submit().trigger('click')
    await vi.waitFor(() => expect(posted()).toHaveLength(1))
    expect(JSON.parse(posted()[0]!.data).initiatorPicks).toEqual({})
  })
})
