// Agent admin pages: write-only keys (empty keeps the stored one), the models editor's checks, the tool
// policy choices (a write tool never "auto"), the external MCP sync status, skill import / export, the
// instructions and the root-only params, the usage page's grouping, totals, key figures and completeness
// notes, and the settings page's getting-started guide.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElMessageBox, ElSelect } from 'element-plus'
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
import McpTools from '@/views/platform/agent/setting/McpTools.vue'
import UsageEntries from '@/views/platform/agent/usage/UsageEntries.vue'
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
import {
  chartPoints,
  formatCredits,
  integrityNotes,
  sumTokens,
} from '@/views/platform/agent/usage/usage-summary'
import SetupGuide from '@/views/platform/agent/setting/SetupGuide.vue'
import {
  guideComplete,
  guideSteps,
  guideStorageKey,
  readGuide,
} from '@/views/platform/agent/setting/setup-guide'
import { fail, me, mockApi, ok } from './mock-api'

const AT = '2026-10-22T01:00:00.000Z'
const SETTING = ['agent.setting.browse', 'agent.setting.modify']

let w: VueWrapper
/** Mounts `component` with the app's plugins; `root` false signs in as a non-root platform admin. */
async function show(
  component: object,
  {
    perms = SETTING,
    root = true,
    props = {} as Record<string, unknown>,
    routes = [] as { path: string; name: string }[],
  } = {},
) {
  useAuthStore().me = root ? me(['*', ...perms]) : { ...me(perms), roles: ['admin'] }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { render: () => null } },
      ...routes.map((r) => ({ ...r, component: { render: () => null } })),
    ],
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
  it('saves exact rates, explicit free pricing, cache inheritance and default reasoning', async () => {
    const provider = { ...PROVIDER, models: [{ ...PROVIDER.models[0]!, reasoning: true }] }
    const calls = mockApi({
      'GET /agent/providers': ok([provider]),
      'PUT /agent/providers/3': ok(provider),
    })
    await show(ProviderForm, { props: { id: 3 } })
    expect(w.text()).toContain(t('agent.admin.model.pricingMissing'))
    await w.find('.el-collapse-item__header').trigger('click')
    const enabled = w
      .findAll('.el-checkbox')
      .find((node) => node.text() === t('agent.admin.model.pricingEnabled'))!
    await enabled.find('input').setValue(true)
    const rate = (name: string) => w.find(`input[aria-label="${t(`agent.admin.model.${name}`)}"]`)
    await rate('inputCredits').setValue('0.1234567')
    await rate('outputCredits').setValue('0')
    await button(t('crud.action.save'))!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'put', '/agent/providers/3')).toHaveLength(0)
    await rate('inputCredits').setValue('0.123456')
    await rate('cacheReadCredits').setValue('0')
    await rate('imageCredits').setValue('0.000001')
    const defaults = w
      .findAllComponents(ElSelect)
      .find(
        (select) =>
          select.find('input').attributes('aria-label') === t('agent.admin.model.reasoningDefault'),
      )!
    defaults.vm.$emit('update:modelValue', 'off')
    await button(t('crud.action.save'))!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'put', '/agent/providers/3')[0]).toMatchObject({
      models: [
        {
          pricing: {
            input: '0.123456',
            output: '0',
            cacheRead: '0',
            cacheWrite: null,
            imageCredits: '0.000001',
          },
          reasoningDefault: 'off',
          reasoningStyle: 'standard',
        },
      ],
    })
    const style = w
      .findAllComponents(ElSelect)
      .find(
        (select) =>
          select.find('input').attributes('aria-label') === t('agent.admin.model.reasoningStyle'),
      )!
    style.vm.$emit('change', 'vllm')
    await flushPromises()
    expect(w.text()).toContain(t('agent.admin.model.vllmHint'))
    await rate('inputCredits').setValue('0')
    await button(t('crud.action.save'))!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'put', '/agent/providers/3')[1]).toMatchObject({
      models: [{ pricing: { input: '0', output: '0' }, reasoningStyle: 'vllm' }],
    })
  })

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

  it('loads models from the service: needs an address and a usable key, adds new ones as rows', async () => {
    const calls = mockApi({
      'GET /agent/providers': ok([PROVIDER]),
      'PUT /agent/providers/3': ok(PROVIDER),
      'POST /agent/providers/models': ok({
        items: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner', ownedBy: 'deepseek' }],
      }),
    })
    await show(ProviderForm, { props: { id: 3 } })
    const load = () => button(t('agent.admin.model.loadFromService'))!
    expect(load().attributes('disabled')).toBeUndefined()
    const address = w.find('input[placeholder="https://api.example.com/v1"]')
    await address.setValue('https://elsewhere.example/v1')
    await w.find('input[type="password"]').setValue('sk-typed')
    await address.setValue(PROVIDER.baseUrl)
    await w.find('input[type="password"]').setValue('')
    await load().trigger('click')
    await flushPromises()
    expect(sent(calls, 'post', '/agent/providers/models')).toEqual([
      { id: 3, baseUrl: PROVIDER.baseUrl },
    ])
    const pick = w
      .findAllComponents(ElSelect)
      .find((s) => s.find('input').attributes('aria-label') === t('agent.admin.model.pickLoaded'))!
    pick.vm.$emit('update:modelValue', ['deepseek-chat', 'deepseek-reasoner'])
    await flushPromises()
    await button(t('agent.admin.model.addPicked'))!.trigger('click')
    await button(t('crud.action.save'))!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'put', '/agent/providers/3')[0]!.models).toMatchObject([
      { id: 'deepseek-chat', label: 'Chat', fast: true },
      { id: 'deepseek-reasoner', label: '', reasoning: false, fast: false, pricing: null },
    ])
  })

  it('the load button needs only an address: a keyless local service can list its models', async () => {
    const calls = mockApi({ 'POST /agent/providers/models': ok({ items: [{ id: 'qwen3' }] }) })
    await show(ProviderForm)
    const load = () => button(t('agent.admin.model.loadFromService'))!
    expect(load().attributes('disabled')).toBeDefined()
    await w.find('input[placeholder="https://api.example.com/v1"]').setValue('http://ollama/v1')
    expect(load().attributes('disabled')).toBeUndefined()
    await load().trigger('click')
    await flushPromises()
    expect(sent(calls, 'post', '/agent/providers/models')).toEqual([
      { baseUrl: 'http://ollama/v1' },
    ])
  })

  it('shows why loading the models failed (a bad address, a provider deleted meanwhile)', async () => {
    mockApi({ 'POST /agent/providers/models': fail(400, 'A0400', 'Address is not valid') })
    await show(ProviderForm)
    await w.find('input[placeholder="https://api.example.com/v1"]').setValue('api.example.com')
    await button(t('agent.admin.model.loadFromService'))!.trigger('click')
    await flushPromises()
    expect(ElMessage.error).toHaveBeenCalledWith('Address is not valid')
    expect(button(t('agent.admin.model.loadFromService'))!.attributes('disabled')).toBeUndefined()
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
      enabled: true,
    },
    {
      name: 'demo.customer.update',
      title: 'Update customer',
      kind: 'write',
      source: 'local',
      perm: 'demo.customer.modify',
      policy: 'deny',
      defaulted: false,
      enabled: true,
    },
    {
      name: 'memo.save',
      title: 'Save a memo',
      kind: 'write',
      source: 'builtin',
      perm: null,
      policy: 'human',
      defaulted: false,
      enabled: true,
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

  it('offers a write tool ask, people only or deny, a read tool run, ask or off; reset goes back to the default', async () => {
    const calls = mockApi({
      'GET /agent/tools': ok(TOOLS),
      'PUT /agent/tools/demo.customer.update/policy': ok(null),
    })
    await show(ToolTab)
    // the note on top: auto review covers every "needs confirmation" write
    expect(w.text()).toContain(t('agent.admin.policy.note'))
    expect(w.text()).toContain(t('agent.admin.policyHint.human'))
    expect(await options(1)).toEqual([
      t('agent.admin.policy.ask'),
      t('agent.admin.policy.human'),
      t('agent.admin.policy.deny'),
    ])
    expect(await options(0)).toEqual([
      t('agent.admin.policy.auto'),
      t('agent.admin.policy.ask'),
      t('agent.admin.policy.deny'),
    ])
    const reset = w
      .findAll('.el-table__body button')
      .filter((b) => b.text() === t('agent.admin.tool.reset'))
    expect(reset).toHaveLength(2)
    await reset[0]!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'put', '/agent/tools/demo.customer.update/policy')).toEqual([
      { policy: null },
    ])
  })

  it('a tool only people may confirm offers people only or off; a built-in set to people only still offers ask', async () => {
    mockApi({
      'GET /agent/tools': ok([
        { ...TOOLS[2]!, name: 'memory.remember', policy: 'deny', humanOnly: true },
        TOOLS[2],
      ]),
    })
    await show(ToolTab)
    expect(await options(0)).toEqual([t('agent.admin.policy.human'), t('agent.admin.policy.deny')])
    expect(await options(1)).toEqual([
      t('agent.admin.policy.ask'),
      t('agent.admin.policy.human'),
      t('agent.admin.policy.deny'),
    ])
  })

  it('switches a built-in tool on and off; other tools have no switch here', async () => {
    const calls = mockApi({
      'GET /agent/tools': ok(TOOLS),
      'PUT /agent/tools/memo.save/enabled': ok(null),
    })
    await show(ToolTab)
    const switches = w.findAll('.el-table__body .el-switch')
    expect(switches).toHaveLength(1)
    await switches[0]!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'put', '/agent/tools/memo.save/enabled')).toEqual([{ enabled: false }])
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

  it('requires a named trust confirmation even without a read-only hint, and cancellation writes nothing', async () => {
    const tool = {
      id: 9,
      name: 'search.unknown',
      title: null,
      description: null,
      readOnlyHint: false,
      enabled: true,
      policy: 'ask' as const,
    }
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel')
    const calls = mockApi({ 'PUT /agent/mcp-servers/4/tools/9': ok({ ...tool, policy: 'auto' }) })
    await show(McpTools, { props: { server: { ...SERVER, tools: [tool] }, canModify: true } })
    const select = w.findComponent(ElSelect)
    await select.trigger('click')
    await flushPromises()
    expect(
      body()
        .findAll('.el-select-dropdown__item')
        .map((option) => option.text()),
    ).toEqual([
      t('agent.admin.policy.auto'),
      t('agent.admin.policy.ask'),
      t('agent.admin.policy.human'),
      t('agent.admin.policy.deny'),
    ])
    select.vm.$emit('change', 'auto')
    await flushPromises()
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining(SERVER.name),
      expect.any(String),
      expect.any(Object),
    )
    expect(confirm.mock.calls[0]![0]).toContain(tool.name)
    expect(calls.filter((call) => call.method === 'put')).toHaveLength(0)
    confirm.mockResolvedValueOnce('confirm' as never)
    select.vm.$emit('change', 'auto')
    await flushPromises()
    expect(sent(calls, 'put', '/agent/mcp-servers/4/tools/9')).toEqual([{ policy: 'auto' }])
  })

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
        enabled: true,
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
    param(3, 'agent.instructions', ''),
    param(4, 'agent.limit.turn_steps', '20'),
    param(5, 'agent.limit.turn_seconds', '300'),
    param(7, 'agent.limit.turn_credits', '3.000001'),
    param(8, 'agent.limit.user_daily_credits', '10'),
    param(9, 'agent.limit.tenant_daily_credits', '20'),
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

  it('sends an explicit zero for unlimited credits and preserves decimal precision while numeric guards stay positive', async () => {
    const calls = mockApi({
      'GET /settings/params': ok({ items: PARAMS, total: PARAMS.length }),
      'PUT /settings/params/7': ok(null),
      'PUT /settings/params/8': ok(null),
    })
    await show(ParamTab)
    const amount = (name: string) => w.find(`input[aria-label="${t(`agent.admin.limit.${name}`)}"]`)
    await amount('turnCredits').setValue('0')
    await amount('userDailyCredits').setValue('0.1234567')
    await w.find('.param-tab__save-limits').trigger('click')
    await flushPromises()
    expect(calls.filter((call) => call.method === 'put')).toHaveLength(0)
    await amount('userDailyCredits').setValue('0.123456')
    await w.find('.param-tab__save-limits').trigger('click')
    await flushPromises()
    expect(sent(calls, 'put', '/settings/params/7')).toEqual([{ paramValue: '0' }])
    expect(sent(calls, 'put', '/settings/params/8')).toEqual([{ paramValue: '0.123456' }])
    expect(amount('turnSeconds').attributes('aria-valuemin')).toBe('1')
  })

  it('warns when every credit budget is zero and offers the jump to root only', async () => {
    const zero = PARAMS.map((p) =>
      p.paramKey.endsWith('_credits') ? { ...p, paramValue: '0' } : p,
    )
    mockApi({ 'GET /settings/params': ok({ items: zero, total: zero.length }) })
    await show(ParamTab)
    expect(w.find('.param-tab__no-cap').text()).toContain(t('agent.admin.param.noCreditCap'))
    const jump = button(t('agent.admin.param.setCreditCap'))!
    await jump.trigger('click')
    const first = w.find(`input[aria-label="${t('agent.admin.limit.turnCredits')}"]`)
    expect(document.activeElement).toBe(first.element)
    w.unmount()
    mockApi({ 'GET /settings/params': ok({ items: zero, total: zero.length }) })
    await show(ParamTab, { root: false })
    expect(w.find('.param-tab__no-cap').exists()).toBe(true)
    expect(button(t('agent.admin.param.setCreditCap'))).toBeUndefined()
    w.unmount()
    mockApi({ 'GET /settings/params': ok({ items: PARAMS, total: PARAMS.length }) })
    await show(ParamTab)
    expect(w.find('.param-tab__no-cap').exists()).toBe(false)
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
        totalTokens: 1200,
        cacheReadTokens: 100,
        cacheWriteTokens: null,
        reasoningTokens: null,
        credits: '0.1',
        unpricedCalls: 0,
        unreportedCalls: 0,
        legacyCalls: 0,
      },
      {
        key: '2026-10-22',
        label: '2026-10-22',
        calls: 2,
        promptTokens: 500,
        completionTokens: 100,
        totalTokens: 600,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        credits: '0.2',
        unpricedCalls: 1,
        unreportedCalls: 1,
        legacyCalls: 1,
      },
    ],
    user: [
      {
        key: '1',
        label: 'Alice',
        calls: 5,
        promptTokens: 1500,
        completionTokens: 300,
        totalTokens: 1800,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        credits: '0.3',
        unpricedCalls: 1,
        unreportedCalls: 1,
        legacyCalls: 1,
      },
    ],
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
    expect(footer()).toContain('0.3')
    expect(footer()).not.toContain('0.30000000000000004')

    await w
      .findAll('.usage__group label')
      .find((l) => l.text() === t('agent.admin.usage.by.user'))!
      .find('input')
      .setValue(true)
    await flushPromises()
    expect(calls.at(-1)!.params).toMatchObject({ groupBy: 'user' })
    expect(w.find('.el-table__body').text()).toContain('Alice')
  })
  it('retains unknown tokens and unpriced history instead of displaying zero', async () => {
    mockApi({
      'GET /agent/usage': ok([
        {
          ...rowsBy.day![0]!,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          credits: '0',
          unpricedCalls: 1,
          unreportedCalls: 1,
          legacyCalls: 1,
        },
      ]),
    })
    await show(UsagePage)
    expect(w.find('.el-table__body').text()).toContain(t('agent.admin.usage.unknown'))
    expect(w.find('.el-table__footer').text()).toContain(t('agent.admin.usage.unknown'))
  })

  it('formats credits to at most two decimals with grouping and keeps tiny amounts visible', () => {
    expect(formatCredits('150.000000')).toBe('150')
    expect(formatCredits('1234567.5')).toBe(`${(1234567).toLocaleString()}.5`)
    expect(formatCredits('2.345')).toBe('2.35')
    expect(formatCredits('0.999999')).toBe('1')
    expect(formatCredits('0.004')).toBe('<0.01')
    expect(formatCredits('0')).toBe('0')
  })

  it('counts only the completeness problems that occurred and flags partly unknown tokens', () => {
    expect(integrityNotes(rowsBy.day!.slice(0, 1))).toEqual([])
    expect(integrityNotes(rowsBy.day!)).toEqual([
      { kind: 'unpriced', count: 1 },
      { kind: 'unreported', count: 1 },
      { kind: 'legacy', count: 1 },
    ])
    expect(
      integrityNotes([{ ...rowsBy.day![0]!, unpricedCalls: 2 }, rowsBy.day![0]!]).map(
        (n) => n.kind,
      ),
    ).toEqual(['unpriced'])
    const rows = [rowsBy.day![0]!, { ...rowsBy.day![1]!, promptTokens: null }]
    expect(sumTokens(rows, 'promptTokens')).toEqual({ total: 1000, partial: true, known: true })
    expect(sumTokens(rows, 'completionTokens')).toEqual({ total: 300, partial: false, known: true })
  })

  it('fills every day of the range in the daily chart and keeps other groupings as returned', () => {
    const points = chartPoints(rowsBy.day!.slice(1), 'day', ['2026-10-20', '2026-10-23'])
    expect(points.map((p) => p.label)).toEqual([
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
    ])
    expect(points.map((p) => p.credits)).toEqual([0, 0, 0.2, 0])
    expect(chartPoints(rowsBy.user!, 'user', ['2026-10-20', '2026-10-23'])).toHaveLength(1)
  })

  it('shows the key figures and explains completeness problems only when there are any', async () => {
    let rows = rowsBy.day!.slice(0, 1)
    mockApi({ 'GET /agent/usage': () => ok(rows) })
    await show(UsagePage, { perms: ['agent.usage.browse'], root: false })
    expect(w.find('[data-kpi="calls"]').text()).toContain('3')
    expect(w.find('[data-kpi="credits"]').text()).toContain('0.1')
    expect(w.find('[data-kpi="top.day"]').text()).toContain('2026-10-21')
    expect(w.find('.usage__integrity').exists()).toBe(false)
    expect(w.find('.el-table__header').text()).not.toContain(t('agent.admin.usage.unpricedCalls'))

    rows = [...rowsBy.day!, { ...rowsBy.day![1]!, key: '2026-10-23', credits: '149.9' }]
    await button(t('crud.action.search'))!.trigger('click')
    await flushPromises()
    expect(w.find('[data-kpi="credits"]').text()).toContain('150.2')
    expect(w.find('[data-kpi="credits"] strong').attributes('title')).toBe('150.2')
    const notes = w.find('.usage__integrity')
    expect(notes.find('[data-integrity="unpriced"]').text()).toBe(
      i18n.global.t('agent.admin.usage.integrity.unpriced', { n: '2' }),
    )
    expect(notes.find('[data-integrity="legacy"]').exists()).toBe(true)
  })

  it('shows an empty state instead of a chart when the period has no calls', async () => {
    mockApi({ 'GET /agent/usage': ok([]) })
    await show(UsagePage)
    expect(w.find('.usage__empty').exists()).toBe(true)
    expect(w.findComponent({ name: 'QwChart' }).exists()).toBe(false)
  })

  it('shows a live invocation as in progress instead of free or missing-price history', async () => {
    mockApi({
      'GET /agent/usage/entries': ok({
        items: [
          {
            id: 2,
            userId: 1,
            providerId: 3,
            providerName: 'P',
            model: 'M',
            threadId: 7,
            turnId: 9,
            kind: 'chat',
            status: 'pending',
            usage: null,
            pricing: {
              input: '5',
              output: '15',
              cacheRead: null,
              cacheWrite: null,
              imageCredits: null,
            },
            credits: null,
            usageReported: false,
            createdAt: AT,
          },
        ],
        total: 1,
      }),
    })
    await show(UsageEntries, { props: { from: '2026-10-01', to: '2026-10-27' } })
    expect(w.find('.el-table__body').text()).toContain(t('agent.admin.usage.state.pending'))
    expect(w.find('.el-table__body').text()).not.toContain(t('agent.admin.usage.unpriced'))
    await button(t('agent.admin.usage.entry'))!.trigger('click')
    expect(w.find('.usage-entries__detail').text()).toContain(t('agent.admin.usage.pendingHint'))
    expect(w.find('.usage-entries__detail').text()).not.toContain(t('agent.admin.usage.legacy'))
  })

  it('pages original usage and rate snapshots without reconstructing legacy or missing usage', async () => {
    const entry = {
      id: 1,
      userId: 1,
      providerId: 3,
      providerName: 'P',
      model: 'M',
      threadId: 7,
      turnId: 9,
      kind: 'chat',
      usage: null,
      pricing: null,
      credits: null,
      usageReported: false,
      createdAt: AT,
    }
    const calls = mockApi({ 'GET /agent/usage/entries': ok({ items: [entry], total: 21 }) })
    await show(UsageEntries, { props: { from: '2026-10-01', to: '2026-10-26' } })
    expect(calls.find((call) => call.url === '/agent/usage/entries')!.params).toEqual({
      from: '2026-10-01',
      to: '2026-10-26',
      page: 1,
      pageSize: 10,
      sort: '-createdAt',
    })
    expect(w.text()).toContain(t('agent.admin.usage.unpriced'))
    await button(t('agent.admin.usage.entry'))!.trigger('click')
    await flushPromises()
    expect(w.text()).toContain(t('agent.admin.usage.legacy'))
    const files = w.findComponent({ name: 'CodeViewer' }).props('files') as {
      path: string
      content: string
    }[]
    expect(files.find((file) => file.path === 'usage.json')!.content).toBe('null')
    expect(files.find((file) => file.path === 'pricing.json')!.content).toBe('null')
    await w.find('.el-pagination .btn-next').trigger('click')
    await flushPromises()
    expect(
      calls.filter((call) => call.url === '/agent/usage/entries').at(-1)!.params,
    ).toMatchObject({ page: 2 })
    expect(w.find('.usage-entries__detail').exists()).toBe(false)
  })
})

describe('setup guide', () => {
  const steps = (providers: Partial<AgentProviderVo>[], tools = false) =>
    guideSteps(
      providers.map((p) => ({ ...PROVIDER, ...p })),
      [],
      { tools, chat: true },
    )

  it('counts the model step done for any enabled provider with models, as the runtime picks one', () => {
    expect(steps([{}])[0]!.done).toBe(true)
    expect(steps([{ enabled: false }])[0]!.done).toBe(false)
    expect(steps([{ isDefault: false }])[0]!.done).toBe(true)
    expect(steps([{ models: [] }])[0]!.done).toBe(false)
    // web search is optional: the guide is complete without it
    expect(guideComplete(steps([{}], true))).toBe(true)
    expect(guideComplete(steps([{}], false))).toBe(false)
    expect(guideComplete(steps([], true))).toBe(false)
  })

  it('reads no progress from unusable or broken storage', () => {
    localStorage.setItem('qw.agent.setup-guide.9', '{broken')
    expect(readGuide('qw.agent.setup-guide.9')).toEqual({})
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(readGuide('qw.agent.setup-guide.9')).toEqual({})
    localStorage.removeItem('qw.agent.setup-guide.9')
  })

  it('opens tabs, remembers the reviewed tools and the chat visit per user, then collapses', async () => {
    localStorage.removeItem(guideStorageKey(1))
    mockApi({ 'GET /agent/providers': ok([PROVIDER]), 'GET /agent/search-providers': ok([]) })
    await show(SetupGuide, {
      props: { tab: 'providers' },
      routes: [{ path: '/agent/chat', name: 'agent-chat' }],
    })
    const state = (key: string) => w.find(`[data-step="${key}"] .el-tag`).text()
    expect(state('providers')).toBe(t('agent.admin.guide.state.done'))
    expect(state('search')).toBe(t('agent.admin.guide.state.optional'))
    expect(state('tools')).toBe(t('agent.admin.guide.state.todo'))
    expect(button(t('agent.admin.guide.collapse'))).toBeUndefined()
    // 待完成用主要按钮，可选用次要按钮，已完成只是“查看”链接
    const action = (key: string) => w.find(`[data-step="${key}"] button`)
    expect(action('tools').classes()).toContain('el-button--primary')
    expect(action('tools').classes()).not.toContain('is-link')
    expect(action('search').classes()).not.toContain('el-button--primary')
    expect(action('providers').classes()).toContain('is-link')
    expect(action('providers').text()).toBe(t('agent.admin.guide.view'))

    await w.find('[data-step="tools"] button').trigger('click')
    expect(w.emitted('open')).toEqual([['tools']])
    await w.setProps({ tab: 'tools' })
    await flushPromises()
    expect(state('tools')).toBe(t('agent.admin.guide.state.done'))

    await w.find('[data-step="chat"] button').trigger('click')
    await flushPromises()
    expect(w.vm.$router.currentRoute.value.name).toBe('agent-chat')
    await button(t('agent.admin.guide.collapse'))!.trigger('click')
    expect(w.find('.setup-guide__collapsed').exists()).toBe(true)
    expect(readGuide(guideStorageKey(1))).toEqual({ tools: true, chat: true, collapsed: true })
    expect(readGuide(guideStorageKey(2))).toEqual({})
    localStorage.removeItem(guideStorageKey(1))
  })

  it('lists unpriced models and a missing credit cap, with the jumps for root only', async () => {
    const unpriced = {
      ...PROVIDER,
      models: [
        { ...PROVIDER.models[0]!, pricing: null },
        {
          ...PROVIDER.models[0]!,
          id: 'priced',
          label: 'Priced',
          pricing: {
            input: '1',
            output: '2',
            cacheRead: null,
            cacheWrite: null,
            imageCredits: null,
          },
        },
      ],
    }
    const credits = ['turn_credits', 'user_daily_credits', 'tenant_daily_credits'].map((k, i) => ({
      id: i + 1,
      paramKey: `agent.limit.${k}`,
      paramValue: '0',
    }))
    const routes = {
      'GET /agent/providers': ok([unpriced]),
      'GET /agent/search-providers': ok([]),
      'GET /settings/params': ok({ items: credits, total: credits.length }),
    }
    mockApi(routes)
    await show(SetupGuide, { props: { tab: 'providers' } })
    const notice = w.find('.setup-guide__unpriced').text()
    expect(notice).toContain('Chat')
    expect(notice).not.toContain('Priced')
    expect(w.find('.setup-guide__no-cap').text()).toContain(t('agent.admin.param.noCreditCap'))
    await button(t('agent.admin.param.setCreditCap'))!.trigger('click')
    await button(t('agent.admin.guide.setPricing'))!.trigger('click')
    expect(w.emitted('open')).toEqual([['params'], ['providers']])
    w.unmount()
    mockApi(routes)
    await show(SetupGuide, { props: { tab: 'providers' }, root: false })
    expect(w.find('.setup-guide__no-cap').exists()).toBe(true)
    expect(button(t('agent.admin.param.setCreditCap'))).toBeUndefined()
    expect(button(t('agent.admin.guide.setPricing'))).toBeUndefined()
  })

  it('offers no chat button without the chat page', async () => {
    mockApi({ 'GET /agent/providers': ok([]), 'GET /agent/search-providers': ok([]) })
    await show(SetupGuide, { props: { tab: 'providers' } })
    expect(w.find('[data-step="chat"] button').exists()).toBe(false)
    expect(w.find('[data-step="chat"]').text()).toContain(t('agent.admin.guide.noChat'))
    expect(w.find('[data-step="providers"] .el-tag').text()).toBe(t('agent.admin.guide.state.todo'))
  })
})
