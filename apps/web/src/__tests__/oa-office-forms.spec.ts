import type { ExpenseCreate } from '@qiwu/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import ElementPlus, { ElButton, ElMessage } from 'element-plus'
import { createMemoryHistory, createRouter } from 'vue-router'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import { vPerm } from '@/core/permission'
import TripForm from '@/views/oa/trip/form.vue'
import ExpenseForm from '@/views/oa/expense/form.vue'
import SealForm from '@/views/oa/seal/form.vue'
import OaOffice from '@/views/oa/office/index.vue'
import OaRequestList from '@/views/oa/components/OaRequestList.vue'
import OaRequestNew from '@/views/oa/components/OaRequestNew.vue'
import WfTodo from '@/views/workflow/center/todo.vue'
import OaRequestView from '@/views/oa/components/OaRequestView.vue'
import OaAttachments from '@/views/oa/components/OaAttachments.vue'
import { expenseTotal } from '@/views/oa/components/money'
import { mockApi, ok, fail, me } from './mock-api'

const picker = defineComponent({
  name: 'WfUserIds',
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template:
    '<button class="choose-reviewer" @click="$emit(\'update:modelValue\', [7])">Choose reviewer</button>',
})
const wrappers: VueWrapper[] = []
const picks = [{ id: 'review', name: 'Reviewer', type: 'review' }]
const documents = {
  trip: {
    destination: 'North office',
    startAt: '2026-11-01T01:00:00Z',
    endAt: '2026-11-02T01:00:00Z',
    reason: 'Supplier visit',
    estimatedAmount: '0.30',
    attachmentIds: [],
    initiatorPicks: {},
  },
  seal: {
    sealKind: 'company',
    documentName: 'Agreement',
    purpose: 'Approve sealing',
    copies: 2,
    expectedDate: '2026-11-01',
    attachmentIds: [],
    initiatorPicks: {},
  },
  expense: {
    reason: 'Travel',
    tripId: null,
    attachmentIds: [],
    initiatorPicks: {},
    items: [
      {
        expenseDate: '2026-11-01',
        expenseKind: 'transport',
        amount: '0.10',
        description: 'Bus',
        attachmentIds: [],
      },
      {
        expenseDate: '2026-11-01',
        expenseKind: 'meal',
        amount: '0.20',
        description: 'Lunch',
        attachmentIds: [],
      },
    ],
  },
}
const global = () => ({
  plugins: [ElementPlus, i18n],
  directives: { perm: vPerm },
  stubs: { WfUserIds: picker },
})
const submitButton = (form: VueWrapper) =>
  form.findAll('button').find((button) => button.text() === i18n.global.t('oa.create'))!
const choose = async (form: VueWrapper) => {
  await form.find('.choose-reviewer').trigger('click')
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  useAuthStore().me = me(['*'])
  vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
  vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
})
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

async function formFor(
  kind: keyof typeof documents,
  options: {
    picks?: object[]
    post?: ReturnType<typeof ok> | ReturnType<typeof fail>
    metadataIds?: number[]
  } = {},
) {
  const url =
    kind === 'trip' ? '/oa/trips' : kind === 'expense' ? '/oa/expense-claims' : '/oa/seal-requests'
  const calls = mockApi({
    [`GET /wf/models/oa-${kind}/start-info`]: ok({ schema: null, picks: options.picks ?? picks }),
    'GET /settings/dicts/oa.seal_kind/entries': ok({ version: 1, entries: [] }),
    'GET /settings/dicts/oa.expense_kind/entries': ok({ version: 1, entries: [] }),
    [`POST ${url}`]: options.post ?? ok({ id: 5, instanceId: 11 }),
    ...Object.fromEntries(
      (options.metadataIds ?? []).map((id) => [
        `GET /storage/objects/${id}/metadata`,
        ok({
          id,
          originalName: `receipt-${id}.pdf`,
          mime: 'application/pdf',
          size: 10,
          url: null,
          isPublic: false,
          bizTag: 'oa.attachment',
          createdAt: '2026-10-22T01:00:00Z',
        }),
      ]),
    ),
  })
  const component = { trip: TripForm, expense: ExpenseForm, seal: SealForm }[kind]
  const form = mount(component, { global: global(), attachTo: document.body })
  wrappers.push(form)
  await flushPromises()
  Object.assign((form.vm as unknown as { model: object }).model, structuredClone(documents[kind]))
  await nextTick()
  return {
    form,
    posted: () => calls.filter((call) => call.method === 'post' && call.url === url),
    calls,
  }
}

describe('office request forms', () => {
  it('validates required business fields and reviewer choices before forwarding selected IDs', async () => {
    const { form, posted } = await formFor('trip')
    await submitButton(form).trigger('click')
    await flushPromises()
    expect(posted()).toHaveLength(0)
    await choose(form)
    const model = (form.vm as unknown as { model: typeof documents.trip }).model
    model.destination = ''
    await submitButton(form).trigger('click')
    await flushPromises()
    expect(posted()).toHaveLength(0)
    model.destination = 'North office'
    await submitButton(form).trigger('click')
    await vi.waitFor(() => expect(posted()).toHaveLength(1))
    expect(JSON.parse(posted()[0]!.data).initiatorPicks).toEqual({ review: [7] })
    expect(form.emitted('done')?.[0]).toMatchObject([{ id: 5 }])
  })

  it('keeps no-choice models usable and restores pending state after a failed request', async () => {
    const { form, posted } = await formFor('seal', { picks: [], post: fail(422, 'A0422') })
    expect(form.find('.choose-reviewer').exists()).toBe(false)
    await submitButton(form).trigger('click')
    await vi.waitFor(() => expect(posted()).toHaveLength(1))
    await flushPromises()
    expect(submitButton(form).attributes('disabled')).toBeUndefined()
    expect(form.emitted('done')).toBeUndefined()
    expect(JSON.parse(posted()[0]!.data).initiatorPicks).toEqual({})
  })

  it('previews exact decimal totals but never submits a client-owned total or currency', async () => {
    const { form, posted } = await formFor('expense')
    expect(expenseTotal(['0.10', '0.20'])).toBe('0.30')
    expect(expenseTotal(['9999999999.99', '0.01'])).toBeNull()
    expect(expenseTotal(['1e2'])).toBeNull()
    expect(form.find('output').text()).toBe('0.30')
    await choose(form)
    await submitButton(form).trigger('click')
    await vi.waitFor(() => expect(posted()).toHaveLength(1))
    const payload = JSON.parse(posted()[0]!.data)
    expect(payload).not.toHaveProperty('totalAmount')
    expect(payload).not.toHaveProperty('currency')
    expect(payload.items.map((item: { amount: string }) => item.amount)).toEqual(['0.10', '0.20'])
  })

  it('strips read-only detail columns before updating expense items', async () => {
    const calls = mockApi({
      'GET /oa/expense-claims/9': ok({
        id: 9,
        userId: 1,
        state: 'in_review',
        instanceId: 3,
        reason: 'Travel',
        tripId: null,
        totalAmount: '0.10',
        currency: 'CNY',
        attachmentIds: [],
        items: [
          {
            id: 4,
            claimId: 9,
            sortNo: 8,
            expenseDate: '2026-11-01',
            expenseKind: 'transport',
            amount: '0.10',
            description: 'Bus',
            attachmentIds: [],
          },
        ],
      }),
      'GET /settings/dicts/oa.expense_kind/entries': ok({ version: 1, entries: [] }),
      'PUT /oa/expense-claims/9': ok(null),
    })
    const form = mount(ExpenseForm, { props: { id: 9 }, global: global(), attachTo: document.body })
    wrappers.push(form)
    await flushPromises()
    const save = form
      .findAll('button')
      .find((button) => button.text() === i18n.global.t('crud.action.save'))!
    await save.trigger('click')
    await vi.waitFor(() => expect(calls.some((call) => call.method === 'put')).toBe(true))
    const body = JSON.parse(calls.find((call) => call.method === 'put')!.data)
    expect(body).not.toHaveProperty('initiatorPicks')
    expect(body).not.toHaveProperty('userId')
    expect(body.items[0]).toMatchObject({ id: 4, amount: '0.10' })
    expect(body.items[0]).not.toHaveProperty('claimId')
    expect(body.items[0]).not.toHaveProperty('sortNo')
  })

  it('renders only the document when embedded readonly and never asks for another approval panel', async () => {
    const calls = mockApi({
      'GET /oa/trips/8': ok({
        id: 8,
        userId: 1,
        instanceId: 4,
        state: 'in_review',
        destination: 'North office',
        startAt: '2026-11-01T01:00:00Z',
        endAt: '2026-11-02T01:00:00Z',
        estimatedAmount: '0.30',
        reason: 'Supplier visit',
      }),
      'GET /settings/dicts/oa.request_state/entries': ok({ version: 1, entries: [] }),
    })
    const router = createRouter({ history: createMemoryHistory(), routes: [] })
    const view = mount(OaRequestView, {
      props: { kind: 'trip', form: TripForm, businessKey: '8', readonly: true },
      global: { ...global(), plugins: [ElementPlus, i18n, router] },
    })
    wrappers.push(view)
    await flushPromises()
    expect(view.text()).toContain('North office')
    expect(view.find('.qw-page-bar').exists()).toBe(false)
    expect(calls.some((call) => call.url?.startsWith('/wf/instances/'))).toBe(false)
  })

  it('keeps the new action in the existing toolbar default slot', async () => {
    mockApi({
      'GET /oa/trips': ok({ items: [], total: 0 }),
      'GET /settings/dicts/oa.request_state/entries': ok({ version: 1, entries: [] }),
    })
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/oa/trip/new', component: { template: '<div />' } }],
    })
    const list = mount(OaRequestList, {
      props: { kind: 'trip' },
      global: {
        ...global(),
        plugins: [ElementPlus, i18n, router],
        stubs: { TableToolbar: { template: '<div><slot /></div>' }, QwTable: true },
      },
    })
    wrappers.push(list)
    await flushPromises()
    const create = list
      .findAll('button')
      .find((button) => button.text() === i18n.global.t('crud.action.create'))!
    expect(create.exists()).toBe(true)
    await create.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/oa/trip/new')
  })

  it('does not offer a create action when workflow exists but its permission is absent', async () => {
    useAuthStore().me = { ...me([]), features: ['workflow', 'oa'] }
    mockApi({
      'GET /wf/startable-models': ok([
        { modelKey: 'oa-trip', formKind: 'custom', createRoute: '/oa/trip/new' },
      ]),
    })
    const router = createRouter({ history: createMemoryHistory(), routes: [] })
    const home = mount(OaOffice, {
      global: { ...global(), plugins: [ElementPlus, i18n, router], stubs: { WfTodo: true } },
    })
    wrappers.push(home)
    await flushPromises()
    expect(home.find('[data-model="oa-trip"] button').exists()).toBe(false)
  })

  it('does not mount a create form or fetch business data without the workflow feature', async () => {
    useAuthStore().me = { ...me(['oa.trip.create', 'oa.trip.browse']), features: ['oa'] }
    const calls = mockApi({})
    const router = createRouter({ history: createMemoryHistory(), routes: [] })
    const list = mount(OaRequestList, {
      props: { kind: 'trip' },
      global: {
        ...global(),
        plugins: [ElementPlus, i18n, router],
        stubs: { TableToolbar: { template: '<div><slot /></div>' }, QwTable: true },
      },
    })
    const page = mount(OaRequestNew, {
      props: { kind: 'trip', form: TripForm },
      global: { ...global(), plugins: [ElementPlus, i18n, router] },
    })
    wrappers.push(list, page)
    await flushPromises()
    expect(
      list
        .findAll('button')
        .some((button) => button.text() === i18n.global.t('crud.action.create')),
    ).toBe(false)
    expect(page.findComponent(TripForm).exists()).toBe(false)
    expect(list.find('.qw-search-panel').exists()).toBe(false)
    expect(list.find('.qw-table-panel').exists()).toBe(false)
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([])
  })

  it('does not mount a directly opened form or call APIs without its create permission', async () => {
    useAuthStore().me = { ...me(['oa.trip.browse']), features: ['workflow', 'oa'] }
    const calls = mockApi({})
    const router = createRouter({ history: createMemoryHistory(), routes: [] })
    const page = mount(OaRequestNew, {
      props: { kind: 'trip', form: TripForm },
      global: { ...global(), plugins: [ElementPlus, i18n, router] },
    })
    wrappers.push(page)
    await flushPromises()
    expect(page.findComponent(TripForm).exists()).toBe(false)
    expect(page.find('.el-alert').text()).toBe(i18n.global.t('oa.notAllowed'))
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([])
  })

  it('forwards the optional type to the existing workflow list and resets pagination when it changes', async () => {
    const calls = mockApi({ 'GET /wf/tasks/todo': ok({ items: [], total: 0 }) })
    const router = createRouter({ history: createMemoryHistory(), routes: [] })
    const list = mount(WfTodo, {
      props: { modelKey: 'oa-trip' },
      global: {
        ...global(),
        plugins: [ElementPlus, i18n, router],
        stubs: { QwTable: true, TableToolbar: true },
      },
    })
    wrappers.push(list)
    await flushPromises()
    expect(calls.filter((call) => call.url === '/wf/tasks/todo').at(-1)?.params).toMatchObject({
      page: 1,
      modelKey: 'oa-trip',
    })
    await list.setProps({ modelKey: 'oa-expense' })
    await flushPromises()
    expect(calls.filter((call) => call.url === '/wf/tasks/todo').at(-1)?.params).toMatchObject({
      page: 1,
      modelKey: 'oa-expense',
    })
    await list.setProps({ modelKey: undefined })
    await flushPromises()
    expect(calls.filter((call) => call.url === '/wf/tasks/todo').at(-1)?.params).not.toHaveProperty(
      'modelKey',
    )
  })

  it('does not offer initiation without workflow feature or creation permission', async () => {
    const auth = useAuthStore()
    auth.me = { ...me([]), features: ['oa'] }
    const calls = mockApi({ 'GET /wf/startable-models': ok([]) })
    const router = createRouter({ history: createMemoryHistory(), routes: [] })
    const home = mount(OaOffice, { global: { ...global(), plugins: [ElementPlus, i18n, router] } })
    wrappers.push(home)
    await flushPromises()
    expect(
      home.findAll('button').filter((button) => button.text() === i18n.global.t('oa.apply')),
    ).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })
})

it('blocks the trip submit action while its attachment field is busy and resumes only after it clears', async () => {
  const { form, posted } = await formFor('trip', { picks: [] })
  const attachment = form.findComponent(OaAttachments)
  attachment.vm.$emit('busy', true)
  await nextTick()
  expect(submitButton(form).attributes('disabled')).toBeDefined()
  const button = form
    .findAllComponents(ElButton)
    .find((entry) => entry.text() === i18n.global.t('oa.create'))!
  button.vm.$emit('click', new MouseEvent('click'))
  await flushPromises()
  expect(posted()).toHaveLength(0)
  attachment.vm.$emit('busy', false)
  await nextTick()
  expect(submitButton(form).attributes('disabled')).toBeUndefined()
  button.vm.$emit('click', new MouseEvent('click'))
  await vi.waitFor(() => expect(posted()).toHaveLength(1))
})

it('blocks expense item uploads and applies the ten-file cap across header and item fields', async () => {
  const ids = Array.from({ length: 11 }, (_, i) => i + 1)
  const { form, posted } = await formFor('expense', { picks: [], metadataIds: ids })
  const itemField = form.findAllComponents(OaAttachments)[0]!
  itemField.vm.$emit('busy', true)
  await nextTick()
  expect(submitButton(form).attributes('disabled')).toBeDefined()
  const button = form
    .findAllComponents(ElButton)
    .find((entry) => entry.text() === i18n.global.t('oa.create'))!
  button.vm.$emit('click', new MouseEvent('click'))
  await flushPromises()
  expect(posted()).toHaveLength(0)
  itemField.vm.$emit('busy', false)
  const model = (form.vm as unknown as { model: ExpenseCreate }).model
  model.attachmentIds = ids.slice(0, 6)
  model.items[0]!.attachmentIds = ids.slice(6)
  await flushPromises()
  expect(form.text()).toContain(i18n.global.t('oa.attachmentLimit'))
  expect(submitButton(form).attributes('disabled')).toBeDefined()
  button.vm.$emit('click', new MouseEvent('click'))
  await flushPromises()
  expect(posted()).toHaveLength(0)
  model.attachmentIds = ids.slice(0, 5)
  await flushPromises()
  expect(submitButton(form).attributes('disabled')).toBeUndefined()
  button.vm.$emit('click', new MouseEvent('click'))
  await vi.waitFor(() => expect(posted()).toHaveLength(1))
  const body = JSON.parse(posted()[0]!.data)
  expect(
    new Set([
      ...body.attachmentIds,
      ...body.items.flatMap((item: { attachmentIds: number[] }) => item.attachmentIds),
    ]).size,
  ).toBe(10)
})
