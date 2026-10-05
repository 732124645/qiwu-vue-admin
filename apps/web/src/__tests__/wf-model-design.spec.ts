// 流程设计: the designer page saves the draft as it is, publishes only a tree the designer's
// check passes (errors on the nodes otherwise), a dynamic model with its fields; plus its helpers and the
// custom model's view component check; leaving with unsaved changes asks first. Against a fake backend.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { h } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import { treeToXml, type WfBeginNode, type WfModelDetailVo, type WfVersionVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import { useTagsStore } from '@/core/stores/tags'
import WfDesigner from '@/views/workflow/designer/WfDesigner.vue'
import ModelDesign from '@/views/workflow/admin/model-design.vue'
import {
  bpmnRefusal,
  designFields,
  draftTree,
  draftXml,
  hasView,
  publishBody,
} from '@/views/workflow/admin/model-list'
import { me, mockApi, ok, type Route } from './mock-api'

/**
 * The BPMN designer (bpmn-js does not run in jsdom) as the page uses it: `change` once its diagram is
 * imported (as bpmn-js writes it: `bpmn:<xml>` here; `unreadable` for `UNDRAWN`) and on every edit;
 * `validate`, `saveXml`, `mark`.
 */
const UNDRAWN = '<no-diagram/>'
const bpmn = vi.hoisted(() => ({
  valid: true,
  checks: 0,
  xml: '<edited/>',
  marked: [] as unknown[],
}))
vi.mock('@/views/workflow/bpmn/WfBpmnDesigner.vue', async () => {
  const { defineComponent, h, onMounted, watch } = await import('vue')
  return {
    default: defineComponent({
      name: 'WfBpmnDesigner',
      props: { xml: { type: String, required: true }, fields: { type: Object, required: true } },
      emits: ['change', 'unreadable'],
      setup(props, { emit, expose }) {
        const load = () =>
          props.xml === UNDRAWN ? emit('unreadable') : emit('change', `bpmn:${props.xml}`, true)
        onMounted(load)
        watch(() => props.xml, load)
        expose({
          validate: () => (bpmn.checks++, bpmn.valid),
          saveXml: async () => bpmn.xml,
          mark: (errors: unknown) => bpmn.marked.push(errors),
        })
        return () => h('div', { class: 'wf-bpmn' })
      },
    }),
  }
})

/** begin → review r1 (users `ids`) */
const flow = (ids: number[]): WfBeginNode => ({
  id: 'begin',
  type: 'begin',
  name: 'Start',
  next: {
    id: 'r1',
    type: 'review',
    name: 'Boss',
    assignee: { kind: 'users', ids },
    sign: 'any',
    whenNobody: 'toManager',
    whenInitiatorIsReviewer: 'self',
    onReject: 'finish',
  },
})
const model = (more: Partial<WfModelDetailVo> = {}): WfModelDetailVo => ({
  id: 5,
  modelKey: 'expense',
  name: 'Expense',
  category: 'finance',
  icon: null,
  description: null,
  formKind: 'dynamic',
  flowKind: 'tree',
  formId: null,
  createRoute: null,
  viewComponent: null,
  initiatorScope: null,
  managerUserIds: null,
  allowCancel: true,
  allowWithdraw: true,
  enabled: true,
  sortNo: 0,
  currentVersionId: 31,
  createdBy: 1,
  createdAt: '2026-10-01T01:00:00.000Z',
  updatedBy: 1,
  updatedAt: '2026-10-01T01:00:00.000Z',
  draftJson: null,
  draftXml: null,
  fields: null,
  ...more,
})
const version = (id: number, n: number, fields = {}): WfVersionVo => ({
  id,
  version: n,
  formSnapshot: { fields },
  publishedBy: 1,
  publishedAt: '2026-10-01T01:00:00.000Z',
})
const V1 = version(31, 1, { amount: 'number' })

describe('design helpers', () => {
  it('fields: the model’s (a custom handler’s), else a dynamic model’s last version’s, else none', () => {
    expect(designFields(model({ formKind: 'custom', fields: { days: 'number' } }), [V1])).toEqual({
      days: 'number',
    })
    expect(designFields(model(), [version(32, 2, { total: 'number' }), V1])).toEqual({
      total: 'number',
    })
    expect(designFields(model(), [])).toEqual({})
  })

  it('tree: the saved draft, or just a begin node when there is none or it is no flow', () => {
    const draft = flow([7]) as unknown as Record<string, unknown>
    expect(draftTree(draft, 'Initiator')).toBe(draft)
    const fresh = { id: 'begin', type: 'begin', name: 'Initiator' }
    expect(draftTree(null, 'Initiator')).toEqual(fresh)
    expect(draftTree({ id: 'x', type: 'review' }, 'Initiator')).toEqual(fresh)
  })

  it('publish body: a dynamic model sends its fields, a custom one the tree (BPMN: the xml) alone', () => {
    const tree = flow([7])
    expect(publishBody(model(), { tree }, { amount: 'number' })).toEqual({
      tree,
      fields: { amount: 'number' },
    })
    expect(publishBody(model({ formKind: 'custom' }), { tree }, { days: 'number' })).toEqual({
      tree,
    })
    expect(publishBody(model(), { xml: '<x/>' }, {})).toEqual({ xml: '<x/>', fields: {} })
    expect(publishBody(model({ formKind: 'custom' }), { xml: '<x/>' }, {})).toEqual({ xml: '<x/>' })
  })

  it('BPMN draft: the saved one, else the diagram of just the begin node (the tree designer’s start)', () => {
    expect(draftXml(model({ flowKind: 'bpmn', draftXml: '<saved/>' }), 'Initiator')).toBe(
      '<saved/>',
    )
    const fresh = draftXml(model({ flowKind: 'bpmn' }), 'Initiator')
    expect(fresh).toBe(treeToXml({ id: 'begin', type: 'begin', name: 'Initiator' }))
    expect(fresh).toContain('<bpmn:startEvent id="begin" name="Initiator">')
  })

  it('BPMN body: refused unread over 80 KiB of XML, with a DOCTYPE, or over the 100 KB JSON limit', () => {
    expect(bpmnRefusal('<x/>')).toBeNull()
    expect(bpmnRefusal('<!doctype x><x/>')).toBe('bpmn_doctype')
    expect(bpmnRefusal('x'.repeat(80 * 1024 + 1))).toBe('bpmn_too_large')
    // 80 KiB of XML, but its quotes double in JSON
    const quoted = '"'.repeat(60 * 1024)
    expect(bpmnRefusal(quoted, { xml: quoted, fields: {} })).toBe('bpmn_too_large')
  })

  it('view component: one of the web’s views', () => {
    expect(hasView('biz/leave/view')).toBe(true)
    expect(hasView(' biz/leave/view ')).toBe(true)
    expect(hasView('biz/leave/missing')).toBe(false)
  })
})

let page: VueWrapper
let router: Router
let calls: ReturnType<typeof mockApi>
/** what the fake backend answers GET /wf/models/5 (and its versions) with */
const stored = { detail: model(), versions: [V1] }
async function mountPage(
  detail: WfModelDetailVo,
  { shown = '.wf-designer', routes = {} as Record<string, Route> } = {},
) {
  Object.assign(stored, { detail, versions: [V1] })
  calls = mockApi({
    'GET /wf/models/5': () => ok(stored.detail),
    'GET /wf/models/5/versions': () => ok(stored.versions),
    'PUT /wf/models/5/draft': ok(null),
    'POST /wf/models/5/versions': ok(version(32, 2)),
    ...routes,
  })
  useAuthStore().me = me(['*'])
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/wf/models', component: { render: () => null } },
      // in a router-view: the leave check needs its route record
      { path: '/wf/models/:id/design', component: ModelDesign },
    ],
  })
  await router.push('/wf/models/5/design')
  page = mount(
    { render: () => h(RouterView) },
    {
      global: { plugins: [ElementPlus, i18n, router], directives: { perm: vPerm } },
      attachTo: document.body,
    },
  )
  // the fake backend answers in microtasks: one flush loads and renders the page
  await flushPromises()
  expect(page.find(shown).exists()).toBe(true)
}
const click = async (key: string) => {
  const text = i18n.global.t(key)
  await page
    .findAll('button')
    .find((b) => b.text() === text)!
    .trigger('click')
  await flushPromises()
}
const sent = (method: string, url: string) =>
  calls.filter((c) => c.method === method && c.url === url)

describe('design page', () => {
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

  it('saves the draft as it is; refuses to publish a tree that does not compile, marking the node', async () => {
    await mountPage(model({ draftJson: flow([]) as unknown as Record<string, unknown> }))
    expect(page.text()).toContain('Current version v1')
    await click('wf.model.design.saveDraft')
    expect(sent('put', '/wf/models/5/draft').map((c) => JSON.parse(c.data as string))).toEqual([
      { tree: flow([]) },
    ])

    await click('wf.model.design.publish')
    expect(ElMessageBox.confirm).not.toHaveBeenCalled()
    expect(sent('post', '/wf/models/5/versions')).toHaveLength(0)
    expect(page.find('[data-node-id="r1"]').classes()).toContain('is-error')
    expect(page.find('.wf-designer__errors').exists()).toBe(true)
  })

  it('publishes the next version with the fields, then shows it as current', async () => {
    const detail = model({ draftJson: flow([7]) as unknown as Record<string, unknown> })
    await mountPage(detail)
    // what the reload after publishing finds
    Object.assign(stored, {
      detail: { ...detail, currentVersionId: 32 },
      versions: [version(32, 2, { amount: 'number' }), V1],
    })
    await click('wf.model.design.publish')
    expect(ElMessageBox.confirm).toHaveBeenCalledWith(
      expect.stringContaining('v2'),
      expect.anything(),
      expect.anything(),
    )
    expect(sent('post', '/wf/models/5/versions').map((c) => JSON.parse(c.data as string))).toEqual([
      { tree: flow([7]), fields: { amount: 'number' } },
    ])
    expect(page.text()).toContain('Current version v2')
  })
})

describe('leaving the design page', () => {
  const DESIGN = '/wf/models/5/design'
  beforeEach(async () => {
    setActivePinia(createPinia())
    setLocale('en-US')
    accessToken.value = 'at'
    vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
    await mountPage(model({ draftJson: flow([7]) as unknown as Record<string, unknown> }))
    useTagsStore().open(router.currentRoute.value)
  })
  afterEach(() => {
    page.unmount()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
    setLocale('zh-CN')
  })
  /** an edit in the designer (it edits the tree in place or hands a new one) */
  const edit = async () => {
    page.findComponent(WfDesigner).vm.$emit('update:modelValue', { ...flow([7]), name: 'Changed' })
    await flushPromises()
  }
  const unload = () => {
    const e = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(e)
    return e.defaultPrevented
  }
  const tagged = () => useTagsStore().tags.some((t) => t.path === DESIGN)

  it('nothing changed: back leaves without asking and closes the tag', async () => {
    const confirm = vi.spyOn(ElMessageBox, 'confirm')
    expect(unload()).toBe(false)
    await click('wf.model.design.back')
    expect(confirm).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/wf/models')
    expect(tagged()).toBe(false)
  })

  it('changed: back asks; cancel stays with the tag, confirm leaves', async () => {
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel')
    await edit()
    expect(unload()).toBe(true)
    await click('wf.model.design.back')
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0]![0]).toBe(i18n.global.t('wf.model.design.leaveConfirm'))
    expect(router.currentRoute.value.path).toBe(DESIGN)
    expect(tagged()).toBe(true)

    // any other way out asks too: a closed tab (TagsView drops its tag first, then navigates)
    confirm.mockRejectedValueOnce('cancel')
    useTagsStore().close((t) => t.path === DESIGN)
    await router.push('/wf/models')
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(router.currentRoute.value.path).toBe(DESIGN)
    expect(tagged()).toBe(true)
    // another model's design page: the same route, a new page (the layout keys the view by path)
    confirm.mockRejectedValueOnce('cancel')
    await router.push('/wf/models/6/design')
    expect(confirm).toHaveBeenCalledTimes(3)
    expect(router.currentRoute.value.path).toBe(DESIGN)

    confirm.mockResolvedValueOnce('confirm' as never)
    await click('wf.model.design.back')
    expect(router.currentRoute.value.path).toBe('/wf/models')
    expect(tagged()).toBe(false)
  })

  it('saved after the change: leaves without asking', async () => {
    const confirm = vi.spyOn(ElMessageBox, 'confirm')
    await edit()
    await click('wf.model.design.saveDraft')
    expect(sent('put', '/wf/models/5/draft')).toHaveLength(1)
    expect(unload()).toBe(false)
    await router.push('/wf/models')
    expect(confirm).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/wf/models')
  })
})

describe('BPMN design page', () => {
  const BPMN = model({ flowKind: 'bpmn' })
  const stub = () => page.findComponent({ name: 'WfBpmnDesigner' })
  /** an edit on the canvas */
  const edit = async () => {
    stub().vm.$emit('change', '<edited/>', false)
    await flushPromises()
  }
  beforeEach(() => {
    setActivePinia(createPinia())
    setLocale('en-US')
    accessToken.value = 'at'
    Object.assign(bpmn, { valid: true, checks: 0, xml: '<edited/>', marked: [] })
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
    vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
  })
  afterEach(() => {
    page.unmount()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
    setLocale('zh-CN')
  })

  it('a new model shows the begin node’s diagram; the draft is saved as bpmn-js writes it', async () => {
    await mountPage(BPMN, { shown: '.wf-bpmn' })
    expect(page.find('.wf-designer').exists()).toBe(false)
    expect(stub().props('xml')).toBe(draftXml(BPMN, i18n.global.t('wf.designer.type.begin')))
    // checked before saving (its errors marked), saved all the same: a draft may be half drawn
    bpmn.valid = false
    await click('wf.model.design.saveDraft')
    expect(bpmn.checks).toBe(1)
    expect(sent('put', '/wf/models/5/draft').map((c) => JSON.parse(c.data as string))).toEqual([
      { xml: '<edited/>' },
    ])
  })

  it('publishes only a diagram its check passes, as xml with the fields; a refused one is marked', async () => {
    const refused = {
      code: 'A0400',
      msg: 'refused',
      data: null,
      errors: [
        { path: 'xml.R1', msg: 'R1 has no reviewers' },
        { path: 'xml', msg: 'too large' },
      ],
      traceId: 't-1',
    }
    await mountPage(model({ flowKind: 'bpmn', draftXml: '<saved/>' }), {
      shown: '.wf-bpmn',
      routes: { 'POST /wf/models/5/versions': [400, refused] },
    })
    expect(stub().props('xml')).toBe('<saved/>')
    bpmn.valid = false
    await click('wf.model.design.publish')
    expect(ElMessageBox.confirm).not.toHaveBeenCalled()
    expect(sent('post', '/wf/models/5/versions')).toHaveLength(0)

    bpmn.valid = true
    await click('wf.model.design.publish')
    expect(ElMessageBox.confirm).toHaveBeenCalledOnce()
    expect(sent('post', '/wf/models/5/versions').map((c) => JSON.parse(c.data as string))).toEqual([
      { xml: '<edited/>', fields: { amount: 'number' } },
    ])
    expect(bpmn.marked).toEqual([refused.errors])
    expect(ElMessage.error).toHaveBeenCalledWith('refused')
  })

  it('a diagram the server would refuse unread is not sent', async () => {
    await mountPage(BPMN, { shown: '.wf-bpmn' })
    bpmn.xml = '<!DOCTYPE x><x/>'
    await click('wf.model.design.saveDraft')
    expect(sent('put', '/wf/models/5/draft')).toHaveLength(0)
    expect(ElMessage.error).toHaveBeenCalledWith(i18n.global.t('validation.wf.bpmn_doctype'))
  })

  it('a stored draft bpmn-js cannot draw gives way to the begin node’s diagram, said in a notice', async () => {
    const warning = vi.spyOn(ElMessage, 'warning').mockReturnValue(undefined as never)
    const button = (key: string) =>
      page.findAll('button').find((b) => b.text() === i18n.global.t(key))!
    await mountPage(model({ flowKind: 'bpmn', draftXml: UNDRAWN }), { shown: '.wf-bpmn' })
    expect(stub().props('xml')).toBe(draftXml(BPMN, i18n.global.t('wf.designer.type.begin')))
    expect(warning).toHaveBeenCalledOnce()
    expect(warning.mock.calls[0]![0]).toMatchObject({
      message: i18n.global.t('wf.model.design.draftUnreadable'),
    })
    // usable again: imported, exported, saved over the stored draft
    for (const key of ['import', 'exportBpmn', 'saveDraft', 'publish'])
      expect(button(`wf.model.design.${key}`).attributes('disabled')).toBeUndefined()
    await click('wf.model.design.saveDraft')
    expect(sent('put', '/wf/models/5/draft').map((c) => JSON.parse(c.data as string))).toEqual([
      { xml: '<edited/>' },
    ])
  })

  it('unsaved edits ask before leaving; saved, it leaves without asking', async () => {
    await mountPage(BPMN, { shown: '.wf-bpmn' })
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel')
    // the imported diagram is the saved state
    await router.push('/wf/models')
    expect(confirm).not.toHaveBeenCalled()
    await router.push('/wf/models/5/design')
    await flushPromises()
    expect(page.find('.wf-bpmn').exists()).toBe(true)

    await edit()
    await router.push('/wf/models')
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0]![0]).toBe(i18n.global.t('wf.model.design.leaveConfirm'))
    expect(router.currentRoute.value.path).toBe('/wf/models/5/design')

    await click('wf.model.design.saveDraft')
    await router.push('/wf/models')
    expect(confirm).toHaveBeenCalledOnce()
    expect(router.currentRoute.value.path).toBe('/wf/models')
  })
})
