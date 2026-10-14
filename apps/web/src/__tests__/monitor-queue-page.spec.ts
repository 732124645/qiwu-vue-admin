// Queue monitor page (monitor/queue): the empty state without queues, the counts per queue, the jobs
// drawer by state, retrying and removing a job (spinning and disabled while pending), perms.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import { monitorPerms, type QueueJobVo, type QueueVo } from '@qiwu/shared'
import { setLocale, i18n } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import QueuePage from '@/views/platform/monitor/queue/index.vue'
import { me, mockApi, ok, type Route } from './mock-api'

const QUEUES: QueueVo[] = [
  {
    name: 'im-fanout',
    waiting: 2,
    prioritized: 4,
    active: 1,
    delayed: 0,
    failed: 3,
    completed: 1200,
    paused: false,
  },
  {
    name: 'mail-send',
    waiting: 0,
    prioritized: 0,
    active: 0,
    delayed: 0,
    failed: 0,
    completed: 0,
    paused: true,
  },
]
const JOB: QueueJobVo = {
  id: '17',
  name: 'deliver',
  tenantId: 4,
  attemptsMade: 3,
  attempts: 3,
  failedReason: 'smtp down',
  createdAt: '2026-10-14T08:00:00.000Z',
  processedAt: '2026-10-14T08:00:01.000Z',
  finishedAt: '2026-10-14T08:00:02.000Z',
  data: '{"to":"a@example.com","password":"***"}',
}

function backend(extra: Record<string, Route> = {}) {
  return mockApi({
    'GET /monitor/queues': ok(QUEUES),
    'GET /monitor/queues/im-fanout/jobs': (c) =>
      ok(c.params?.state === 'failed' ? { items: [JOB], total: 1 } : { items: [], total: 0 }),
    'POST /monitor/queues/im-fanout/jobs/17/retry': ok(null),
    'DELETE /monitor/queues/im-fanout/jobs/17': ok(null),
    ...extra,
  })
}

let page: VueWrapper
async function mountPage(perms = ['*']) {
  useAuthStore().me = me(perms)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  await router.push('/')
  page = mount(QueuePage, {
    global: { plugins: [ElementPlus, i18n, router], directives: { perm: vPerm } },
    attachTo: document.body,
  })
  await flushPromises()
}
const rows = () => page.findAll('.qw-table-panel .el-table__body .el-table__row')
const drawer = () => document.querySelector('.el-drawer') as HTMLElement | null
/** the drawer's buttons showing `text` (v-perm hides the others with display: none) */
const drawerButtons = (text: string) =>
  [...(drawer()?.querySelectorAll('button') ?? [])].filter(
    (b) => b.textContent?.trim() === text && b.style.display !== 'none',
  )

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
  vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
})
afterEach(() => {
  page.unmount()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('queue monitor', () => {
  it('shows an empty state while no queue is registered', async () => {
    backend({ 'GET /monitor/queues': ok([]) })
    await mountPage()
    expect(rows()).toHaveLength(0)
    expect(page.text()).toContain('No queue is registered yet')
  })

  it('lists each queue with its counts and state', async () => {
    backend()
    await mountPage()
    expect(rows()).toHaveLength(2)
    const first = rows()[0]!.text()
    expect(first).toContain('im-fanout')
    expect(first).toContain('1,200')
    expect(first).toContain('Running')
    expect(rows()[1]!.text()).toContain('Paused')
    expect(page.text()).not.toContain('No queue is registered yet')
  })

  it('opens the failed jobs, switches state, retries and removes with the pending button spinning', async () => {
    const calls = backend()
    await mountPage()
    // the failed count opens the drawer on the failed jobs
    await rows()[0]!
      .findAll('button')
      .find((b) => b.text() === '3')!
      .trigger('click')
    await flushPromises()
    expect(drawer()?.textContent).toContain('Jobs of im-fanout')
    expect(calls.at(-1)?.params).toMatchObject({ state: 'failed', page: 1 })
    expect(drawer()?.textContent).toContain('smtp down')
    expect(drawer()?.textContent).toContain('3 / 3')

    // retry: pending → spinning, the other button disabled
    let release!: () => void
    const retries = backend({
      'POST /monitor/queues/im-fanout/jobs/17/retry': () =>
        new Promise((r) => (release = () => r(ok(null)))),
    })
    drawerButtons('Retry')[0]!.click()
    await flushPromises()
    expect(drawerButtons('Retry')[0]!.classList.contains('is-loading')).toBe(true)
    expect(drawerButtons('Delete')[0]!.disabled).toBe(true)
    release()
    await flushPromises()
    expect(retries.filter((c) => c.method === 'post').map((c) => c.url)).toEqual([
      '/monitor/queues/im-fanout/jobs/17/retry',
    ])
    expect(ElMessage.success).toHaveBeenCalledWith('The job was queued again')
    expect(drawerButtons('Delete')[0]!.disabled).toBe(false)

    // remove, after the confirm
    const removes = backend()
    drawerButtons('Delete')[0]!.click()
    await flushPromises()
    expect(ElMessageBox.confirm).toHaveBeenCalledWith(
      'Delete job 17? This cannot be undone.',
      expect.any(String),
      expect.any(Object),
    )
    expect(removes.filter((c) => c.method === 'delete').map((c) => c.url)).toEqual([
      '/monitor/queues/im-fanout/jobs/17',
    ])

    // another state: no retry button
    const states = () => drawer()!.querySelectorAll<HTMLInputElement>('.el-radio-button input')
    expect([...states()].map((i) => i.value)).toEqual([
      'failed',
      'completed',
      'delayed',
      'waiting',
      'prioritized',
      'active',
    ])
    states()[1]!.click()
    await flushPromises()
    expect(removes.at(-1)?.params).toMatchObject({ state: 'completed', page: 1 })
    expect(drawer()?.textContent).toContain('No jobs in this state')
  })

  it('lists the running jobs read-only and opens a state from its count', async () => {
    const calls = backend({
      'GET /monitor/queues/im-fanout/jobs': ok({
        items: [{ ...JOB, failedReason: null }],
        total: 1,
      }),
    })
    await mountPage()
    // the active count opens the running jobs
    await rows()[0]!
      .findAll('button')
      .find((b) => b.text() === '1')!
      .trigger('click')
    await flushPromises()
    expect(calls.at(-1)?.params).toMatchObject({ state: 'active' })
    expect(drawer()?.textContent).toContain('deliver')
    expect(drawerButtons('Retry')).toHaveLength(0)
    expect(drawerButtons('Delete')).toHaveLength(0)
    // the prioritized count opens those
    await rows()[0]!
      .findAll('button')
      .find((b) => b.text() === '4')!
      .trigger('click')
    await flushPromises()
    expect(calls.at(-1)?.params).toMatchObject({ state: 'prioritized' })
    expect(drawerButtons('Delete')).toHaveLength(1)
  })

  it('hides retry and delete without their perms', async () => {
    backend()
    await mountPage([monitorPerms.queue])
    await rows()[0]!
      .findAll('button')
      .find((b) => b.text() === 'Jobs')!
      .trigger('click')
    await flushPromises()
    expect(drawer()?.textContent).toContain('smtp down')
    expect(drawerButtons('Retry')).toHaveLength(0)
    expect(drawerButtons('Delete')).toHaveLength(0)
  })
})
