// Leave request page (see docs/design-notes.md#workflow): edit and resubmit only for the owner holding the process's
// begin task (edit also needs biz.leave.modify); a reviewer sees neither; the readonly embedding (the
// instance detail) is the request alone. Against a fake backend.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import { leavePerms, type LeaveVo, type WfInstanceDetailVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import LeaveView from '@/views/biz/leave/view.vue'
import { me, mockApi, ok } from './mock-api'

const ROW: LeaveVo = {
  id: 7,
  userId: 1,
  deptId: null,
  leaveKind: 'annual',
  startAt: '2026-10-08T01:00:00.000Z',
  endAt: '2026-10-09T10:00:00.000Z',
  days: 2,
  reason: 'Family trip',
  state: 'sent_back',
  instanceId: 40,
  createdBy: 1,
  createdAt: '2026-09-30T01:00:00.000Z',
  updatedBy: 1,
  updatedAt: '2026-09-30T01:00:00.000Z',
}
const detail = (myTasks: WfInstanceDetailVo['myTasks']): WfInstanceDetailVo => ({
  id: 40,
  modelKey: 'leave',
  modelName: 'seed.wf.leave',
  title: 'Leave-Admin-2026-09-30',
  formKind: 'custom',
  viewComponent: 'biz/leave/view',
  businessKey: '7',
  state: 'running',
  initiator: { id: 1, name: 'Admin' },
  startedAt: '2026-09-30T01:00:00.000Z',
  endedAt: null,
  myTasks,
  signs: [],
  withdrawable: null,
  canCancel: false,
  canUrge: false,
  fields: {},
  schema: null,
  formValues: {},
  access: {},
  tree: { id: 'begin', type: 'begin', name: 'Begin' },
  progress: { begin: 'done' },
  bpmnXml: null,
  timeline: [],
})
const BEGIN = {
  id: 91,
  nodeId: 'begin',
  nodeName: 'seed.wf.begin',
  type: 'begin',
  commentRequired: false,
  child: false,
} as const
const REVIEW = {
  id: 92,
  nodeId: 'sup',
  nodeName: 'seed.wf.leaveSupervisor',
  type: 'review',
  commentRequired: false,
  child: false,
} as const

let page: VueWrapper
let calls: ReturnType<typeof mockApi>
async function mountView(
  opts: { perms?: string[]; tasks?: WfInstanceDetailVo['myTasks']; readonly?: boolean } = {},
) {
  calls = mockApi({
    'GET /biz/leaves/7': ok(ROW),
    'GET /wf/instances/40': ok(detail(opts.tasks ?? [])),
    'POST /wf/tasks/91/resubmit': ok(null),
  })
  useAuthStore().me = me(opts.perms ?? ['*'])
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/biz/leave', component: { render: () => null } },
      { path: '/biz/leave/:id', component: { render: () => null } },
    ],
  })
  await router.push('/biz/leave/7')
  page = mount(LeaveView, {
    props: opts.readonly ? { businessKey: '7', readonly: true } : {},
    global: { plugins: [ElementPlus, i18n, router], directives: { perm: vPerm } },
    attachTo: document.body,
  })
  await vi.waitFor(async () => {
    await flushPromises()
    expect(page.find('.el-descriptions').exists()).toBe(true)
  })
  await flushPromises()
}
const button = (text: string) => page.findAll('button').find((b) => b.text() === text)
const visible = (text: string) => {
  const b = button(text)
  return !!b && (b.element as HTMLElement).style.display !== 'none'
}
const asked = (url: string) => calls.some((c) => c.url === url)

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

describe('leave view', () => {
  const edit = () => i18n.global.t('crud.action.edit')
  const resubmit = () => i18n.global.t('biz.leave.resubmit')
  const sentBack = () => page.text().includes(i18n.global.t('biz.leave.sentBack'))

  it('owner with the begin task and modify: edit, resubmit (of that task) and the sent-back alert', async () => {
    await mountView({ perms: [leavePerms.browse, leavePerms.modify], tasks: [BEGIN] })
    expect(visible(edit())).toBe(true)
    expect(visible(resubmit())).toBe(true)
    expect(sentBack()).toBe(true)
    await button(resubmit())!.trigger('click')
    await vi.waitFor(() => expect(asked('/wf/tasks/91/resubmit')).toBe(true))
  })

  it('owner with the begin task without modify: resubmit only', async () => {
    await mountView({ perms: [leavePerms.browse], tasks: [BEGIN] })
    expect(visible(edit())).toBe(false)
    expect(visible(resubmit())).toBe(true)
  })

  it('a reviewer holding a review task: neither button, no alert', async () => {
    await mountView({ tasks: [REVIEW] })
    expect(asked('/wf/instances/40')).toBe(true)
    expect(page.find('.leave-view__flow').exists()).toBe(true)
    expect(button(edit())).toBeUndefined()
    expect(button(resubmit())).toBeUndefined()
    expect(sentBack()).toBe(false)
  })

  it('readonly embedding: the request alone, no page bar, no instance request', async () => {
    await mountView({ tasks: [BEGIN], readonly: true })
    expect(page.find('.qw-page-bar').exists()).toBe(false)
    expect(page.find('.leave-view__flow').exists()).toBe(false)
    expect(sentBack()).toBe(false)
    expect(asked('/wf/instances/40')).toBe(false)
    expect(page.text()).toContain('Family trip')
    // a card title of its own, not the in-sentence noun (`entity`: "leave request")
    expect(page.find('.el-descriptions__title').text()).toBe('Leave request')
  })
})
