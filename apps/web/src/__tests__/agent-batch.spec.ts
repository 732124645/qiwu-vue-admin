// Batch runs on the sample customers: the list's "let the agent fill in" button (only with the batch page in
// the menu, enabled with a selection, confirms, creates the batch with the fixed skill, opens the batch page)
// and the batch review page (rows with their record name, status and pending changes, approve / reject all and
// the approvals it skipped, open a row's chat, polling only while shown, refreshing on the rows' live events).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, KeepAlive, ref } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import { type AgentBatchDetailVo, DEMO_CUSTOMER_ENRICH_SKILL, type CustomerVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import { useMenuStore } from '@/core/stores/menu'
import CustomerList from '@/views/demo/customer/index.vue'
import BatchPage from '@/views/platform/agent/batch/index.vue'
import { me, mockApi, node, ok, type Route } from './mock-api'

/** the fake socket: the page subscribes to agent:event */
const rt = vi.hoisted(() => ({ handlers: new Map<string, (payload: unknown) => void>() }))
vi.mock('@/core/realtime/socket', async () => {
  const { shallowRef } = await import('vue')
  return {
    realtimeStatus: shallowRef('up'),
    onRealtime: (type: string, fn: (payload: unknown) => void) => {
      rt.handlers.set(type, fn)
      return () => rt.handlers.delete(type)
    },
  }
})

const AT = '2026-10-22T08:00:00.000Z'
const customer = (id: number, name: string): CustomerVo => ({
  id,
  name,
  website: null,
  industry: null,
  city: null,
  scale: null,
  phone: null,
  address: null,
  intro: null,
  deptId: null,
  createdBy: 1,
  createdAt: AT,
  updatedBy: null,
  updatedAt: AT,
})

let w: VueWrapper | undefined
let router: Router
const button = (text: string) => w!.findAll('button').find((b) => b.text().startsWith(text))

beforeEach(async () => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  useAuthStore().me = me(['*'])
  vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { render: () => null } },
      { path: '/agent/batch', name: 'agent-batch', component: { render: () => null } },
      { path: '/agent/chat', name: 'agent-chat', component: { render: () => null } },
    ],
  })
  await router.push('/')
})
afterEach(() => {
  w?.unmount()
  w = undefined
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

const mountList = async () => {
  w = mount(CustomerList, {
    global: { plugins: [ElementPlus, i18n, router], directives: { perm: vPerm } },
    attachTo: document.body,
  })
  await flushPromises()
}
const withBatchPage = () =>
  (useMenuStore().tree = [
    node({
      id: 1,
      routePath: '/agent/batch',
      routeName: 'agent-batch',
      component: 'platform/agent/batch/index',
      visible: false,
    }),
  ])

describe('customer list button', () => {
  const list = {
    'GET /demo/customers': ok({ items: [customer(3, 'Acme'), customer(4, 'Beta')], total: 2 }),
  }

  it('hidden while the agent (its batch page) is not in the menu', async () => {
    mockApi(list)
    await mountList()
    expect(button('Let the agent fill in')).toBeUndefined()
  })

  it('enabled with a selection; confirms, creates the batch with the fixed skill and opens the batch page', async () => {
    const calls = mockApi({ ...list, 'POST /agent/batches': ok({ id: 9 }) })
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    withBatchPage()
    await mountList()
    expect(button('Let the agent fill in')!.attributes('disabled')).toBeDefined()
    await w!.findAll('.el-table__body .el-checkbox')[0]!.trigger('click')
    await flushPromises()
    const btn = button('Let the agent fill in')!
    expect(btn.attributes('disabled')).toBeUndefined()
    await btn.trigger('click')
    await flushPromises()
    expect(String(confirm.mock.calls[0]![0])).toContain('1 selected customers')
    const post = calls.find((c) => c.method === 'post')
    expect(JSON.parse(String(post?.data))).toEqual({
      skill: DEMO_CUSTOMER_ENRICH_SKILL,
      target: 'demo.customer',
      ids: [3],
    })
    expect(router.currentRoute.value).toMatchObject({ name: 'agent-batch', query: { id: '9' } })
  })

  it('cancelling the confirmation sends nothing', async () => {
    const calls = mockApi(list)
    vi.spyOn(ElMessageBox, 'confirm').mockRejectedValue('cancel')
    withBatchPage()
    await mountList()
    await w!.findAll('.el-table__body .el-checkbox')[0]!.trigger('click')
    await flushPromises()
    await button('Let the agent fill in')!.trigger('click')
    await flushPromises()
    expect(calls.some((c) => c.method === 'post')).toBe(false)
  })
})

describe('batch review page', () => {
  const approval = {
    id: 51,
    seq: 4,
    turnId: 2,
    kind: 'approval' as const,
    status: 'pending' as const,
    payload: {
      callId: 'c1',
      tool: 'demo.customer.update',
      title: 'Fill in customer details',
      args: { id: 3, website: 'https://acme.example.com' },
      changes: {
        target: 'Acme (#3)',
        fields: [{ field: 'website', from: null, to: 'https://acme.example.com' }],
      },
      sources: [{ title: 'Acme', url: 'https://acme.example.com/about' }],
    },
    createdAt: AT,
  }
  const detail = (pending: boolean): AgentBatchDetailVo => ({
    batch: {
      id: 9,
      skill: DEMO_CUSTOMER_ENRICH_SKILL,
      target: 'demo.customer',
      status: pending ? 'running' : 'completed',
      total: 2,
      finished: pending ? 0 : 2,
      failed: 0,
      createdAt: AT,
    },
    rows: [
      {
        label: 'Acme',
        targetId: 3,
        threadId: 21,
        turnStatus: pending ? 'waiting' : 'completed',
        pending: pending ? [approval] : [],
      },
      {
        label: 'Beta Ltd',
        targetId: 4,
        threadId: 22,
        turnStatus: pending ? null : 'completed',
        pending: [],
      },
    ],
  })

  it('shows each row with its status and pending changes; approve all decides the batch and reloads', async () => {
    let decided = false
    const calls = mockApi({
      'GET /agent/batches/9': () => ok(detail(!decided)),
      'POST /agent/batches/9/decide': () => ((decided = true), ok({ decided: 1 })),
    })
    await router.push('/agent/batch?id=9')
    w = mount(BatchPage, { global: { plugins: [ElementPlus, i18n, router] } })
    await flushPromises()
    const rows = w.findAll('.agent-batch__row')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.text()).toContain('Acme (#3)')
    expect(rows[0]!.text()).toContain('Waiting for you')
    expect(rows[0]!.text()).toContain('https://acme.example.com')
    expect(rows[0]!.find('.agent-batch__record').text()).toBe('Acme')
    expect(rows[1]!.find('.agent-batch__record').text()).toBe('Beta Ltd')
    expect(rows[1]!.text()).toContain('Queued')
    await button('Approve all (1)')!.trigger('click')
    await flushPromises()
    const post = calls.find((c) => c.url === '/agent/batches/9/decide')
    expect(JSON.parse(String(post?.data))).toEqual({ decision: 'approve' })
    expect(w.text()).toContain('2 done')
    expect(button('Approve all (0)')!.attributes('disabled')).toBeDefined()
    // a row's chat opens in the chat page
    await w.findAll('.agent-batch__row')[1]!.find('button').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value).toMatchObject({ name: 'agent-chat', query: { thread: '22' } })
  })

  it('says how many approvals approve-all skipped and keeps them listed', async () => {
    vi.spyOn(ElMessage, 'warning').mockReturnValue(undefined as never)
    mockApi({
      'GET /agent/batches/9': ok(detail(true)),
      'POST /agent/batches/9/decide': ok({ decided: 0, skipped: 1 }),
    })
    await router.push('/agent/batch?id=9')
    w = mount(BatchPage, { global: { plugins: [ElementPlus, i18n, router] } })
    await flushPromises()
    await button('Approve all (1)')!.trigger('click')
    await flushPromises()
    expect(ElMessage.warning).toHaveBeenCalledWith(
      expect.stringMatching(/^1 approvals .* one by one/),
    )
    expect(w.findAll('.agent-approval')).toHaveLength(1)
  })

  it('offers "don\'t ask again" on a pending card only when the card allows it', async () => {
    for (const sessionAllow of [false, true]) {
      const d = detail(true)
      d.rows[0]!.pending = [{ ...approval, payload: { ...approval.payload, sessionAllow } }]
      mockApi({ 'GET /agent/batches/9': ok(d) })
      await router.push('/agent/batch?id=9')
      w = mount(BatchPage, { global: { plugins: [ElementPlus, i18n, router] } })
      await flushPromises()
      expect(w.findAll('.agent-approval button').some((b) => b.text().startsWith('Don'))).toBe(
        sessionAllow,
      )
      w.unmount()
    }
    w = undefined
  })

  it('polls only while shown, and refreshes on a live event of its rows', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const calls = mockApi({ 'GET /agent/batches/9': ok(detail(true)) as Route })
      const gets = () => calls.filter((c) => c.url === '/agent/batches/9').length
      const tick = async (ms: number) => {
        await vi.advanceTimersByTimeAsync(ms)
        await flushPromises()
      }
      await router.push('/agent/batch?id=9')
      const shown = ref(true)
      const Other = defineComponent({ name: 'OtherPage', render: () => null })
      const Host = defineComponent({
        setup: () => () => h(KeepAlive, null, [shown.value ? h(BatchPage) : h(Other)]),
      })
      w = mount(Host, { global: { plugins: [ElementPlus, i18n, router] } })
      await flushPromises()
      expect(gets()).toBe(1)
      await tick(3000)
      expect(gets()).toBe(2)

      // hidden by keep-alive: no polling; shown again: reloads at once
      shown.value = false
      await tick(9000)
      expect(gets()).toBe(2)
      shown.value = true
      await flushPromises()
      expect(gets()).toBe(3)

      // the browser tab hidden: no polling; visible again: reloads
      const setVisibility = (v: string) => {
        Object.defineProperty(document, 'visibilityState', { value: v, configurable: true })
        document.dispatchEvent(new Event('visibilitychange'))
      }
      setVisibility('hidden')
      await tick(9000)
      expect(gets()).toBe(3)
      setVisibility('visible')
      await flushPromises()
      expect(gets()).toBe(4)

      // a live event of one of its threads refreshes soon; another thread's does not
      rt.handlers.get('agent:event')!({ threadId: 99, type: 'turn', turn: {} })
      await tick(400)
      expect(gets()).toBe(4)
      rt.handlers.get('agent:event')!({ threadId: 21, type: 'turn', turn: {} })
      await tick(400)
      expect(gets()).toBe(5)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reject all sends the rejection', async () => {
    const calls = mockApi({
      'GET /agent/batches/9': ok(detail(true)),
      'POST /agent/batches/9/decide': ok({ decided: 1 }),
    })
    await router.push('/agent/batch?id=9')
    w = mount(BatchPage, { global: { plugins: [ElementPlus, i18n, router] } })
    await flushPromises()
    await button('Reject all')!.trigger('click')
    await flushPromises()
    const post = calls.find((c) => c.url === '/agent/batches/9/decide')
    expect(JSON.parse(String(post?.data))).toEqual({ decision: 'reject' })
  })
})
