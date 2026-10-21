// Agent admin pages: write-only keys (empty keeps the stored one), the models editor's checks, the tool
// policy choices (a write tool never "auto"), the external MCP sync status, skill import / export, the
// instructions and the root-only params, and the usage page's grouping and totals.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import type {
  AgentMcpServerVo,
  AgentProviderVo,
  AgentSkillVo,
  AgentToolVo,
  AgentUsageRowVo,
  ParameterVo,
} from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { dialogs } from '@/core/dialog'
import { appSettings } from '@/core/stores/app'
import { useAuthStore } from '@/core/stores/auth'
import ProviderForm from '@/views/platform/agent/setting/ProviderForm.vue'
import McpTab from '@/views/platform/agent/setting/McpTab.vue'
import ParamTab from '@/views/platform/agent/setting/ParamTab.vue'
import ProviderTab from '@/views/platform/agent/setting/ProviderTab.vue'
import SearchTab from '@/views/platform/agent/setting/SearchTab.vue'
import ToolTab from '@/views/platform/agent/setting/ToolTab.vue'
import InstructionPanel from '@/views/platform/agent/skill/InstructionPanel.vue'
import SkillImport from '@/views/platform/agent/skill/SkillImport.vue'
import SkillForm from '@/views/platform/agent/skill/SkillForm.vue'
import SkillList from '@/views/platform/agent/skill/SkillList.vue'
import UsagePage from '@/views/platform/agent/usage/index.vue'
import { me, mockApi, ok } from './mock-api'

const AT = '2026-10-22T01:00:00.000Z'
const SETTING = ['agent.setting.browse', 'agent.setting.modify']

let w: VueWrapper
/** Mounts `component` with the app's plugins; `root` false signs in as a non-root platform admin. */
async function show(
  component: object,
  { perms = SETTING, root = true, props = {} as Record<string, unknown> } = {},
) {
  useAuthStore().me = root ? me(['*', ...perms]) : { ...me(perms), roles: ['admin'] }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  await router.push('/')
  w = mount(component, {
    props,
    global: {
      plugins: [ElementPlus, i18n, router],
      directives: { perm: vPerm },
      stubs: { QwChart: true },
    },
    attachTo: document.body,
  })
  await flushPromises()
}
const t = (key: string) => i18n.global.t(key)
const body = () => new DOMWrapper(document.body)
const button = (text: string) => w.findAll('button').find((b) => b.text() === text)
const sent = (
  calls: { method?: string; url?: string; data?: unknown }[],
  method: string,
  url: string,
) =>
  calls
    .filter((c) => c.method === method && c.url === url)
    .map((c) => JSON.parse(String(c.data)) as Record<string, unknown>)

beforeEach(() => {
  // 断言逐个找行内按钮：把操作列的直接显示个数放宽，不让按钮收进“更多”
  appSettings.value.tableActionsVisible = 9
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
  vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
})
afterEach(() => {
  w?.unmount()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

const PROVIDER: AgentProviderVo = {
  id: 3,
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com/v1',
  hasKey: true,
  models: [
    {
      id: 'deepseek-chat',
      label: 'Chat',
      reasoning: false,
      vision: false,
      fast: true,
      contextWindow: 64000,
    },
  ],
  enabled: true,
  isDefault: true,
  sort: 0,
}

describe('provider form', () => {
  it('keeps the stored key when the key is left empty, sends a typed one', async () => {
    const calls = mockApi({
      'GET /agent/providers': ok([PROVIDER]),
      'PUT /agent/providers/3': ok(PROVIDER),
    })
    await show(ProviderForm, { props: { id: 3 } })
    expect(w.text()).toContain(t('agent.admin.keyStored'))
    const key = w.find('input[type="password"]')
    expect(key.attributes('placeholder')).toBe(t('crud.placeholder.secretKeep'))
    await button(t('crud.action.save'))!.trigger('click')
    await flushPromises()
    const [first] = sent(calls, 'put', '/agent/providers/3')
    expect(first).not.toHaveProperty('apiKey')
    expect(first).toMatchObject({ name: 'DeepSeek', models: [{ id: 'deepseek-chat' }] })

    await key.setValue('sk-new')
    await button(t('crud.action.save'))!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'put', '/agent/providers/3')[1]).toMatchObject({ apiKey: 'sk-new' })
  })

  it('checks every model row and needs at least one model', async () => {
    const calls = mockApi({ 'POST /agent/providers': ok({ ...PROVIDER, id: 9 }) })
    await show(ProviderForm)
    await w.find('input[maxlength="64"]').setValue('Local')
    await w
      .find('input[placeholder="https://api.example.com/v1"]')
      .setValue('http://ollama:11434/v1')
    // the first model row starts empty: its id is required
    await button(t('crud.action.save'))!.trigger('click')
    await flushPromises()
    expect(calls.filter((c) => c.method === 'post')).toHaveLength(0)
    expect(w.findAll('.qw-edit-table .el-form-item.is-error')).toHaveLength(1)
    // no rows at all: the list reports
    await w
      .findAll('.qw-edit-table button')
      .find((b) => b.text() === t('crud.action.delete'))!
      .trigger('click')
    await button(t('crud.action.save'))!.trigger('click')
    await flushPromises()
    expect(w.find('.provider-form__models').classes()).toContain('is-error')
    expect(calls.filter((c) => c.method === 'post')).toHaveLength(0)
    // one row with an id saves; the empty key is left out
    await button(t('crud.action.addRow'))!.trigger('click')
    await w.find('input[aria-label="Model ID"]').setValue('qwen3')
    await button(t('crud.action.save'))!.trigger('click')
    await flushPromises()
    const [created] = sent(calls, 'post', '/agent/providers')
    expect(created).toMatchObject({
      name: 'Local',
      models: [{ id: 'qwen3', contextWindow: 64000 }],
    })
    expect(created).not.toHaveProperty('apiKey')
  })
})

describe('tool policies', () => {
  const TOOLS: AgentToolVo[] = [
    {
      name: 'demo.customer.get',
      title: 'Customer',
      kind: 'read',
      source: 'local',
      perm: null,
      policy: 'auto',
      defaulted: true,
    },
    {
      name: 'demo.customer.update',
      title: 'Update customer',
      kind: 'write',
      source: 'local',
      perm: 'demo.customer.modify',
      policy: 'deny',
      defaulted: false,
    },
  ]

  /** the option labels of the n-th policy select (its own listbox), opened */
  async function options(n: number) {
    const select = w.findAll('.el-table__body .el-select')[n]!
    await select.find('.el-select__wrapper').trigger('click')
    await flushPromises()
    const listbox = select.find('input').attributes('aria-controls')!
    return body()
      .findAll(`#${listbox} .el-select-dropdown__item`)
      .map((o) => o.text())
  }

  it('offers a write tool only ask or deny; reset goes back to the default', async () => {
    const calls = mockApi({
      'GET /agent/tools': ok(TOOLS),
      'PUT /agent/tools/demo.customer.update/policy': ok(null),
    })
    await show(ToolTab)
    expect(await options(1)).toEqual([t('agent.admin.policy.ask'), t('agent.admin.policy.deny')])
    expect(await options(0)).toEqual([
      t('agent.admin.policy.auto'),
      t('agent.admin.policy.ask'),
      t('agent.admin.policy.deny'),
    ])
    const reset = w
      .findAll('.el-table__body button')
      .filter((b) => b.text() === t('agent.admin.tool.reset'))
    expect(reset).toHaveLength(1)
    await reset[0]!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'put', '/agent/tools/demo.customer.update/policy')).toEqual([
      { policy: null },
    ])
  })

  it('shows no editable select without the modify permission', async () => {
    mockApi({ 'GET /agent/tools': ok(TOOLS) })
    await show(ToolTab, { perms: ['agent.setting.browse'], root: false })
    expect(
      w.findAll('.el-table__body .el-select.is-disabled, .el-table__body .is-disabled').length,
    ).toBeGreaterThan(0)
    expect(w.text()).not.toContain(t('agent.admin.tool.reset'))
  })
})

describe('external mcp servers', () => {
  const SERVER: AgentMcpServerVo = {
    id: 4,
    name: 'crm-tools',
    url: 'https://mcp.example.com/mcp',
    authKind: 'header',
    hasAuth: true,
    allowPrivate: false,
    enabled: true,
    status: 'unknown',
    lastError: null,
    syncedAt: null,
    tools: [],
  }

  it('syncs a server and shows its status, error and time', async () => {
    const calls = mockApi({
      'GET /agent/mcp-servers': ok([SERVER]),
      'POST /agent/mcp-servers/4/sync': ok({
        ...SERVER,
        status: 'error',
        lastError: 'connect ECONNREFUSED',
        syncedAt: AT,
      }),
    })
    await show(McpTab)
    expect(w.find('.el-table__body').text()).toContain(t('agent.admin.mcp.state.unknown'))
    await w
      .findAll('.el-table__body button')
      .find((b) => b.text() === t('agent.admin.mcp.sync'))!
      .trigger('click')
    await flushPromises()
    expect(calls.filter((c) => c.method === 'post').map((c) => c.url)).toEqual([
      '/agent/mcp-servers/4/sync',
    ])
    const row = w.find('.el-table__body').text()
    expect(row).toContain(t('agent.admin.mcp.state.error'))
    expect(row).toContain('connect ECONNREFUSED')
    expect(row).toMatch(/2026-10-22 \d{2}:00/)
  })
})

describe('skills', () => {
  const SKILL: AgentSkillVo = {
    id: 7,
    scope: 'user',
    name: 'fill-customer',
    description: 'When customer fields are empty',
    body: 'Search the web.',
    tools: null,
    enabled: true,
    editable: true,
    updatedAt: AT,
  }
  const MD =
    '---\nname: fill-customer\ndescription: "When fields are empty"\ntools: [web.search, demo.customer.update]\n---\n\nSearch the web.\n'

  it('imports a pasted SKILL.md through the server', async () => {
    const calls = mockApi({ 'POST /agent/skills/import': ok(SKILL) })
    await show(SkillImport, { perms: ['agent.chat.use'], root: false })
    await w.find('textarea').setValue(MD)
    await button(t('crud.action.import'))!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'post', '/agent/skills/import')).toEqual([{ scope: 'user', text: MD }])
    expect(w.emitted('done')).toEqual([[{ id: 7 }]])
  })

  it('imports and exports a platform skill through the platform-skill routes', async () => {
    const calls = mockApi({
      'POST /agent/platform-skills/import': ok({ ...SKILL, scope: 'platform' }),
      'GET /agent/platform-skills': ok([{ ...SKILL, scope: 'platform' }]),
      'GET /agent/platform-skills/7/export': ok({ text: MD }),
    })
    await show(SkillImport, { props: { platform: true } })
    await w.find('textarea').setValue(MD)
    await button(t('crud.action.import'))!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'post', '/agent/platform-skills/import')).toEqual([{ text: MD }])
    expect(sent(calls, 'post', '/agent/skills/import')).toEqual([])
    w.unmount()

    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:skill')
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockReturnValue(undefined)
    await show(SkillList, { props: { platform: true } })
    await button(t('crud.action.export'))!.trigger('click')
    await flushPromises()
    expect(calls.filter((c) => c.method === 'get').map((c) => c.url)).toContain(
      '/agent/platform-skills/7/export',
    )
  })

  it('opens the draft named in the address (from "save as skill") on the skill page', async () => {
    dialogs.splice(0)
    mockApi({ 'GET /agent/skills': ok([{ ...SKILL, enabled: false }]) })
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { render: () => null } }],
    })
    await router.push('/?edit=7')
    useAuthStore().me = me(['agent.chat.use'])
    w = mount(SkillList, {
      global: { plugins: [ElementPlus, i18n, router], directives: { perm: vPerm } },
      attachTo: document.body,
    })
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({})
    expect(dialogs.map((d) => [d.component, d.props])).toEqual([
      [SkillForm, { id: 7, platform: false, canTenant: false }],
    ])
    dialogs.splice(0)
  })

  it('exports a skill as SKILL.md and hides tenant actions without the permission', async () => {
    const tenant: AgentSkillVo = { ...SKILL, id: 8, scope: 'tenant', name: 'team' }
    mockApi({
      'GET /agent/skills': ok([SKILL, tenant]),
      'GET /agent/skills/7/export': ok({ text: MD }),
    })
    const blobs: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      blobs.push(b as Blob)
      return 'blob:skill'
    })
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockReturnValue(undefined)
    await show(SkillList, { perms: ['agent.chat.use'], root: false })
    const rows = w.findAll('.el-table__body tr')
    // own skill: edit + export + delete; tenant skill without agent.skill.*: export only
    expect(rows[0]!.findAll('button').map((b) => b.text())).toEqual([
      t('crud.action.edit'),
      t('crud.action.export'),
      t('crud.action.delete'),
    ])
    expect(rows[1]!.findAll('button').map((b) => b.text())).toEqual([t('crud.action.export')])
    await rows[0]!.findAll('button')[1]!.trigger('click')
    await flushPromises()
    expect(click).toHaveBeenCalledOnce()
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('SKILL.md')
    expect(await blobs[0]!.text()).toBe(MD)
  })
})

describe('root-only settings', () => {
  const ROUTES = {
    'GET /agent/providers': ok([PROVIDER]),
    'GET /agent/search-providers': ok([
      { id: 2, name: 'Bocha', kind: 'bocha', hasKey: true, enabled: true, isDefault: true },
    ]),
    'GET /agent/mcp-servers': ok([
      {
        id: 4,
        name: 'crm-tools',
        url: 'https://mcp.example.com/mcp',
        authKind: 'none',
        hasAuth: false,
        allowPrivate: false,
        enabled: true,
        status: 'ok',
        lastError: null,
        syncedAt: null,
        tools: [],
      },
    ]),
    'GET /agent/tools': ok([
      {
        name: 'demo.customer.update',
        title: 'Update',
        kind: 'write',
        source: 'local',
        perm: null,
        policy: 'deny',
        defaulted: false,
      },
    ]),
    'GET /agent/platform-skills': ok([
      {
        id: 7,
        scope: 'platform',
        name: 'fill-customer',
        description: 'd',
        body: 'b',
        tools: null,
        enabled: true,
        editable: true,
        updatedAt: AT,
      },
    ]),
    'GET /settings/params': ok({ items: [], total: 0 }),
  }
  const WRITES = [
    t('crud.action.create'),
    t('crud.action.edit'),
    t('crud.action.delete'),
    t('crud.action.import'),
    t('agent.admin.mcp.sync'),
    t('agent.admin.tool.reset'),
  ]
  const tabs: [string, object, Record<string, unknown>][] = [
    ['providers', ProviderTab, {}],
    ['search', SearchTab, {}],
    ['mcp', McpTab, {}],
    ['tools', ToolTab, {}],
    ['platform skills', SkillList, { platform: true }],
  ]

  it.each(tabs)(
    '%s: a non-root holder of the modify permission sees no write action and the hint',
    async (_, tab, props) => {
      mockApi(ROUTES)
      await show(tab, { root: false, props })
      const labels = w.findAll('button').map((b) => b.text())
      for (const label of WRITES) expect(labels).not.toContain(label)
      expect(w.text()).toContain(t('agent.admin.rootOnly'))
      expect(w.find('.el-switch:not(.is-disabled)').exists()).toBe(false)
      expect(w.find('.el-table__body .el-select__wrapper:not(.is-disabled)').exists()).toBe(false)
    },
  )

  it('root still gets the write actions', async () => {
    mockApi(ROUTES)
    await show(ProviderTab)
    expect(button(t('crud.action.create'))).toBeDefined()
    expect(w.text()).not.toContain(t('agent.admin.rootOnly'))
    w.unmount()
    await show(SkillList, { props: { platform: true } })
    expect(button(t('crud.action.import'))).toBeDefined()
  })
})

describe('instructions', () => {
  it('saves the personal instructions and tone; tenant ones are read-only without the permission', async () => {
    const calls = mockApi({
      'GET /agent/instructions/me': ok({ body: 'Use tables', tone: 'concise' }),
      'GET /agent/instructions/tenant': ok({ body: 'Be polite' }),
      'PUT /agent/instructions/me': ok(null),
    })
    await show(InstructionPanel, { perms: ['agent.chat.use'], root: false })
    const tenant = w.find('.instruction-panel__tenant textarea')
    expect((tenant.element as HTMLTextAreaElement).value).toBe('Be polite')
    expect(tenant.attributes('readonly')).toBeDefined()
    expect(w.findAll('button').filter((b) => b.text() === t('crud.action.save'))).toHaveLength(1)
    await w.find('.instruction-panel__mine textarea').setValue('Answer in tables')
    await button(t('crud.action.save'))!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'put', '/agent/instructions/me')).toEqual([
      { body: 'Answer in tables', tone: 'concise' },
    ])
  })

  it('saves the tenant instructions with agent.instruction.modify', async () => {
    const calls = mockApi({
      'GET /agent/instructions/me': ok({ body: '' }),
      'GET /agent/instructions/tenant': ok({ body: '' }),
      'PUT /agent/instructions/tenant': ok(null),
    })
    await show(InstructionPanel, {
      perms: ['agent.chat.use', 'agent.instruction.modify'],
      root: false,
    })
    await w.find('.instruction-panel__tenant textarea').setValue('Cite sources')
    await w.find('.instruction-panel__save').trigger('click')
    await flushPromises()
    expect(sent(calls, 'put', '/agent/instructions/tenant')).toEqual([{ body: 'Cite sources' }])
  })
})

describe('root-only params', () => {
  const param = (id: number, paramKey: string, paramValue: string): ParameterVo => ({
    id,
    paramKey,
    paramValue,
    name: paramKey,
    nameI18n: null,
    groupCode: null,
    isBuiltin: true,
    isSecret: false,
    isPublic: false,
    note: null,
    createdBy: null,
    createdAt: AT,
    updatedBy: null,
    updatedAt: AT,
  })
  const PARAMS = [
    param(1, 'agent.paused', 'false'),
    param(2, 'agent.trust_mode', 'true'),
    param(3, 'agent.instructions', ''),
    param(4, 'agent.limit.turn_steps', '20'),
    param(5, 'agent.limit.turn_seconds', '300'),
    // the key filter matches by "contains": a param outside the prefix is ignored
    param(6, 'mcp.agent.x', '1'),
  ]

  it('pauses only after a confirm and saves the platform instructions', async () => {
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel')
    const calls = mockApi({
      'GET /settings/params': ok({ items: PARAMS, total: PARAMS.length }),
      'PUT /settings/params/1': ok(null),
      'PUT /settings/params/3': ok(null),
    })
    await show(ParamTab)
    expect(calls[0]!.params).toMatchObject({ paramKey: 'agent.' })
    await w.find('.param-tab__paused').trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledOnce()
    expect(calls.filter((c) => c.method === 'put')).toHaveLength(0)

    confirm.mockResolvedValueOnce('confirm' as never)
    await w.find('.param-tab__paused').trigger('click')
    await flushPromises()
    expect(sent(calls, 'put', '/settings/params/1')).toEqual([{ paramValue: 'true' }])

    await w.find('.param-tab__instructions textarea').setValue('Never delete records.')
    await w.find('.param-tab__save-instructions').trigger('click')
    await flushPromises()
    expect(sent(calls, 'put', '/settings/params/3')).toEqual([
      { paramValue: 'Never delete records.' },
    ])
  })

  it('saves only the changed limits', async () => {
    const calls = mockApi({
      'GET /settings/params': ok({ items: PARAMS, total: PARAMS.length }),
      'PUT /settings/params/5': ok(null),
    })
    await show(ParamTab)
    const seconds = w.find(`input[aria-label="${t('agent.admin.limit.turnSeconds')}"]`)
    await seconds.setValue('120')
    await seconds.trigger('change')
    await w.find('.param-tab__save-limits').trigger('click')
    await flushPromises()
    expect(calls.filter((c) => c.method === 'put').map((c) => c.url)).toEqual([
      '/settings/params/5',
    ])
    expect(sent(calls, 'put', '/settings/params/5')).toEqual([{ paramValue: '120' }])
  })

  it('shows no edit controls to a non-root admin', async () => {
    mockApi({ 'GET /settings/params': ok({ items: PARAMS, total: PARAMS.length }) })
    await show(ParamTab, { root: false })
    expect(w.text()).toContain(t('agent.admin.rootOnly'))
    expect(w.find('.param-tab__save').exists()).toBe(false)
    expect(w.find('.param-tab__paused').classes()).toContain('is-disabled')
    expect(w.find('.param-tab__instructions textarea').attributes('readonly')).toBeDefined()
  })
})

describe('usage page', () => {
  const rowsBy: Record<string, AgentUsageRowVo[]> = {
    day: [
      {
        key: '2026-10-21',
        label: '2026-10-21',
        calls: 3,
        promptTokens: 1000,
        completionTokens: 200,
      },
      {
        key: '2026-10-22',
        label: '2026-10-22',
        calls: 2,
        promptTokens: 500,
        completionTokens: 100,
      },
    ],
    user: [{ key: '1', label: 'Alice', calls: 5, promptTokens: 1500, completionTokens: 300 }],
  }

  it('groups by day, then by user, with a totals row', async () => {
    const calls = mockApi({
      'GET /agent/usage': (c) => ok(rowsBy[(c.params as { groupBy: string }).groupBy] ?? []),
    })
    await show(UsagePage, { perms: ['agent.usage.browse'], root: false })
    expect(calls[0]!.params).toMatchObject({ groupBy: 'day' })
    expect(calls[0]!.params.from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const footer = () => w.find('.el-table__footer').text()
    expect(footer()).toContain(t('agent.admin.usage.total'))
    expect(footer()).toContain((1500).toLocaleString())
    expect(footer()).toContain((1800).toLocaleString())

    await w
      .findAll('.usage__group label')
      .find((l) => l.text() === t('agent.admin.usage.by.user'))!
      .find('input')
      .setValue(true)
    await flushPromises()
    expect(calls.at(-1)!.params).toMatchObject({ groupBy: 'user' })
    expect(w.find('.el-table__body').text()).toContain('Alice')
  })
})
