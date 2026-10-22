// Agent automations page: the list (trigger texts, owner-only actions for shared rows, switch and run now
// with their requests), the edit form (a schedule preset fills the cron, pre-approval lists the write tools
// and asks for the current password only when a tool is added) and the run history (statuses, translated
// reasons, opening a run's hidden chat).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage } from 'element-plus'
import type { AgentAutomationRunVo, AgentAutomationVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { dialogs } from '@/core/dialog'
import { appSettings } from '@/core/stores/app'
import { useAuthStore } from '@/core/stores/auth'
import AutomationForm from '@/views/platform/agent/automation/AutomationForm.vue'
import AutomationPage from '@/views/platform/agent/automation/index.vue'
import RunHistory from '@/views/platform/agent/automation/RunHistory.vue'
import { me, mockApi, ok } from './mock-api'

const AT = '2026-10-22T01:00:00.000Z'
const PERMS = ['agent.automation.use', 'agent.automation.share', 'agent.chat.use']

const row = (p: Partial<AgentAutomationVo> & { id: number }): AgentAutomationVo => ({
  name: `auto ${p.id}`,
  enabled: true,
  shared: false,
  ownerName: 'admin',
  trigger: 'manual',
  cron: null,
  timezone: null,
  event: null,
  skill: null,
  prompt: 'Look around',
  profileId: null,
  writeMode: 'read_only',
  preApproved: [],
  stalePreApproved: [],
  notify: { inbox: true, mail: false },
  lastRunAt: null,
  nextRunAt: null,
  editable: true,
  ...p,
})

let w: VueWrapper
let router: Router
async function show(component: object, props: Record<string, unknown> = {}) {
  useAuthStore().me = { ...me(PERMS), roles: ['admin'] }
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { render: () => null } },
      { path: '/agent/chat', name: 'agent-chat', component: { render: () => null } },
    ],
  })
  await router.push('/')
  w = mount(component, {
    props,
    global: { plugins: [ElementPlus, i18n, router], directives: { perm: vPerm } },
    attachTo: document.body,
  })
  await flushPromises()
}
const t = (key: string, args?: Record<string, unknown>) => i18n.global.t(key, args ?? {})
const button = (text: string) => w.findAll('button').filter((b) => b.text() === text)
const sent = (
  calls: { method?: string; url?: string; data?: unknown }[],
  method: string,
  url: string,
) =>
  calls
    .filter((c) => c.method === method && c.url === url)
    .map((c) => (c.data ? (JSON.parse(String(c.data)) as Record<string, unknown>) : {}))

beforeEach(() => {
  appSettings.value.tableActionsVisible = 9
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
  vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
})
afterEach(() => {
  w?.unmount()
  dialogs.splice(0)
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('automation list', () => {
  it('describes triggers and offers the actions only on own rows', async () => {
    mockApi({
      'GET /agent/automations': ok([
        row({ id: 1, trigger: 'schedule', cron: '0 9 * * *', timezone: 'Asia/Shanghai' }),
        row({
          id: 2,
          trigger: 'event',
          event: { domain: 'demo.customer', verb: 'create' },
          shared: true,
          editable: false,
          ownerName: 'alice',
        }),
      ]),
    })
    await show(AutomationPage)
    const text = w.text()
    expect(text).toContain(`${t('agent.automation.preset.daily9')} (Asia/Shanghai)`)
    expect(text).toContain('Sample customers · Add')
    expect(text).toContain(t('agent.automation.sharedTag'))
    expect(text).toContain('alice')
    // one row of actions: the shared row of another owner has none
    expect(button(t('agent.automation.runNow'))).toHaveLength(1)
    expect(button(t('crud.action.edit'))).toHaveLength(1)
    expect(w.findAll('.el-switch')).toHaveLength(1)
  })

  it('runs now and switches with the routes of the automation', async () => {
    const calls = mockApi({
      'GET /agent/automations': ok([row({ id: 7 })]),
      'POST /agent/automations/7/run': ok({ id: 1 }),
      'POST /agent/automations/7/enabled': ok(row({ id: 7, enabled: false })),
    })
    await show(AutomationPage)
    await button(t('agent.automation.runNow'))[0]!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'post', '/agent/automations/7/run')).toHaveLength(1)
    expect(ElMessage.success).toHaveBeenCalledWith(t('agent.automation.started'))
    await w.find('.el-switch').trigger('click')
    await flushPromises()
    expect(sent(calls, 'post', '/agent/automations/7/enabled')).toEqual([{ enabled: false }])
  })

  it('opens the run history of a row', async () => {
    mockApi({ 'GET /agent/automations': ok([row({ id: 4, name: 'digest' })]) })
    await show(AutomationPage)
    await button(t('agent.automation.runs'))[0]!.trigger('click')
    expect(dialogs.map((d) => [d.component, d.props])).toEqual([[RunHistory, { id: 4 }]])
  })
})

describe('automation form', () => {
  const OPTIONS = {
    'GET /agent/automation-events': ok([
      { domain: 'demo.customer', verb: 'create', label: 'demo.customer · Create' },
    ]),
    'GET /agent/automation-tools': ok([
      { name: 'demo.customer.update', title: 'Update a customer' },
      { name: 'demo.customer.remove', title: 'Delete a customer' },
    ]),
    'GET /agent/options': ok({ skills: [{ name: 'digest', description: 'd', scope: 'user' }] }),
  }

  it('fills the cron from a preset and sends a new schedule', async () => {
    const calls = mockApi({ ...OPTIONS, 'POST /agent/automations': ok(row({ id: 9 })) })
    await show(AutomationForm)
    expect((w.find('input[maxlength="64"]').element as HTMLInputElement).value).toBe('0 9 * * *')
    await w.find('input[maxlength="100"]').setValue('Morning digest')
    await w.find('textarea').setValue('Summarize the new customers')
    await button(t('crud.action.save'))[0]!.trigger('click')
    await flushPromises()
    const [dto] = sent(calls, 'post', '/agent/automations')
    expect(dto).toMatchObject({
      name: 'Morning digest',
      trigger: 'schedule',
      cron: '0 9 * * *',
      writeMode: 'read_only',
      preApproved: [],
    })
    expect(dto).not.toHaveProperty('currentPassword')
  })

  it('offers the profiles the user may use and sends the chosen one', async () => {
    const calls = mockApi({
      ...OPTIONS,
      'GET /agent/profiles': ok([{ id: 4, name: 'Careful helper' }]),
      'POST /agent/automations': ok(row({ id: 9 })),
    })
    await show(AutomationForm)
    const select = w
      .findAll('.el-form-item')
      .find((f) => f.text().includes(t('field.agent.automation.profileId')))
    expect(select).toBeDefined()
    await select!.find('.el-select').trigger('click')
    await flushPromises()
    const option = [...document.querySelectorAll('.el-select-dropdown__item')].find(
      (o) => o.textContent?.trim() === 'Careful helper',
    ) as HTMLElement
    expect(option).toBeDefined()
    option.click()
    await flushPromises()
    await w.find('input[maxlength="100"]').setValue('With a profile')
    await w.find('textarea').setValue('Summarize')
    await button(t('crud.action.save'))[0]!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'post', '/agent/automations')[0]).toMatchObject({ profileId: 4 })
  })

  it('offers auto review only when the options list it, and sends it', async () => {
    mockApi(OPTIONS)
    await show(AutomationForm)
    const label = t('agent.automation.writeMode.auto_review')
    expect(w.findAll('.el-radio').map((r) => r.text())).not.toContain(label)
    w.unmount()

    const calls = mockApi({
      ...OPTIONS,
      'GET /agent/options': ok({ skills: [], approvalModes: ['ask', 'auto_review'] }),
      'POST /agent/automations': ok(row({ id: 9 })),
    })
    await show(AutomationForm)
    const radio = w.findAll('.el-radio').find((r) => r.text() === label)
    expect(radio).toBeDefined()
    await radio!.find('input').setValue(true)
    await flushPromises()
    expect(w.text()).toContain(t('agent.automation.writeModeHint.auto_review'))
    await w.find('input[maxlength="100"]').setValue('Reviewed')
    await w.find('textarea').setValue('Tidy up')
    await button(t('crud.action.save'))[0]!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'post', '/agent/automations')[0]).toMatchObject({
      writeMode: 'auto_review',
    })
  })

  it('asks for the current password only when a tool is added to the pre-approval', async () => {
    const saved = row({
      id: 5,
      writeMode: 'pre_approved',
      preApproved: ['demo.customer.update'],
    })
    const calls = mockApi({
      ...OPTIONS,
      'GET /agent/automations': ok([saved]),
      'PUT /agent/automations/5': ok(saved),
    })
    await show(AutomationForm, { id: 5 })
    expect(w.text()).toContain('Fill in customer details')
    expect(w.find('input[name="currentPassword"]').exists()).toBe(false)
    // tick the second tool: the password field shows up and is sent
    const boxes = w.findAll('.el-checkbox-group .el-checkbox input')
    await boxes[1]!.setValue(true)
    await flushPromises()
    const pw = w.find('input[name="currentPassword"]')
    expect(pw.exists()).toBe(true)
    await pw.setValue('secret#1')
    await button(t('crud.action.save'))[0]!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'put', '/agent/automations/5')).toEqual([
      expect.objectContaining({
        writeMode: 'pre_approved',
        preApproved: ['demo.customer.update', 'demo.customer.remove'],
        currentPassword: 'secret#1',
      }),
    ])
  })
})

describe('run history', () => {
  const run = (p: Partial<AgentAutomationRunVo> & { id: number }): AgentAutomationRunVo => ({
    automationId: 3,
    threadId: null,
    trigger: 'manual',
    status: 'completed',
    summary: null,
    error: null,
    startedAt: AT,
    endedAt: AT,
    ...p,
  })

  it('shows statuses and reasons, and opens a run’s hidden chat', async () => {
    mockApi({
      'GET /agent/automations/3/runs': ok({
        items: [
          run({ id: 2, threadId: 41, summary: 'All good' }),
          run({ id: 1, status: 'skipped', error: 'owner_forbidden', trigger: 'schedule' }),
        ],
        total: 2,
      }),
    })
    await show(RunHistory, { id: 3 })
    const text = w.text()
    expect(text).toContain('All good')
    expect(text).toContain(t('agent.automation.run.endedAt'))
    expect(text).toContain(t('agent.automation.status.skipped'))
    expect(text).toContain(t('agent.automation.error.owner_forbidden'))
    const open = button(t('agent.automation.openThread'))
    expect(open).toHaveLength(1)
    await open[0]!.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ thread: '41' })
  })
})
