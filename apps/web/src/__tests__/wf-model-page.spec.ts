// 模型管理 page: more models than one request loads → a hint and no moves (they would
// renumber the shown rows only); kept alive, it reloads when shown again (a model published meanwhile).
// The process type column; 向导 for dynamic tree models only. The add / edit dialog's process
// managers: changed only with `wf.model.managers`.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h, KeepAlive, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import type { WfModelVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import ModelPage from '@/views/workflow/admin/model.vue'
import WfModelForm from '@/views/workflow/admin/WfModelForm.vue'
import { me, mockApi, ok } from './mock-api'

const model = (id: number, sortNo: number): WfModelVo => ({
  id,
  modelKey: `m${id}`,
  name: `Model ${id}`,
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
  sortNo,
  currentVersionId: null,
  createdBy: 1,
  createdAt: '2026-10-01T01:00:00.000Z',
  updatedBy: 1,
  updatedAt: '2026-10-01T01:00:00.000Z',
})
const ROWS = [model(1, 0), model(2, 1), model(3, 2)]
/** each row's process type cell and whether it offers 向导 */
const kinds = () =>
  host.findAll('.el-table__body .el-table__row').map((tr) => {
    const type = tr.findAll('td').find((td) => ['Tree', 'BPMN'].includes(td.text()))
    const wizard = tr
      .findAll('button')
      .some((b) => b.text() === i18n.global.t('wf.model.list.wizard'))
    return [type?.text(), wizard]
  })

const show = ref(true)
// the page inside keep-alive, swapped for another page and back
const Host = defineComponent({
  setup: () => () => h(KeepAlive, null, [show.value ? h(ModelPage) : h('p', 'other')]),
})
let host: VueWrapper
let calls: ReturnType<typeof mockApi>
const loads = () => calls.filter((c) => c.method === 'get' && c.url === '/wf/models').length
/** what GET /wf/models answers */
let answer = { items: ROWS, total: ROWS.length }

async function mountPage() {
  calls = mockApi({ 'GET /wf/models': () => ok(answer) })
  useAuthStore().me = me(['*'])
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  await router.push('/')
  host = mount(Host, {
    global: { plugins: [ElementPlus, i18n, router], directives: { perm: vPerm } },
    attachTo: document.body,
  })
  await flushPromises()
}
const hint = () => host.find('.wf-model__truncated')
const arrows = () =>
  host
    .findAll('.el-table__body .wf-model__move button')
    .map((b) => b.attributes('disabled') !== undefined)

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  show.value = true
  answer = { items: ROWS, total: ROWS.length }
})
afterEach(() => {
  host.unmount()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('model page', () => {
  it('the whole list: no hint, moves within the category', async () => {
    await mountPage()
    expect(hint().exists()).toBe(false)
    // up / down per row: the first cannot go up, the last cannot go down
    expect(arrows()).toEqual([true, false, false, false, false, true])
  })

  it('more models than loaded: a hint to filter, and every move disabled', async () => {
    answer = { items: ROWS, total: 250 }
    await mountPage()
    expect(hint().text()).toContain('Only the first 200 of 250 models are shown')
    expect(arrows()).toHaveLength(6)
    expect(arrows().every(Boolean)).toBe(true)
  })

  it('kept alive: reloads when shown again, not on the first show', async () => {
    await mountPage()
    expect(loads()).toBe(1)
    show.value = false
    await flushPromises()
    answer = { items: [{ ...ROWS[0]!, currentVersionId: 9 }], total: 1 }
    show.value = true
    await flushPromises()
    expect(loads()).toBe(2)
    expect(host.findAll('.el-table__body .el-table__row')).toHaveLength(1)
    expect(host.find('.el-table__body').text()).toContain('Published')
  })

  it('the process type of each model; 向导 for a dynamic tree model only', async () => {
    answer = {
      items: [
        model(1, 0),
        { ...model(2, 1), flowKind: 'bpmn' },
        { ...model(3, 2), formKind: 'custom' },
      ],
      total: 3,
    }
    await mountPage()
    expect(kinds()).toEqual([
      ['Tree', true],
      ['BPMN', false],
      ['Tree', false],
    ])
  })
})

describe('model dialog: process managers', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setLocale('en-US')
    accessToken.value = 'at'
  })
  afterEach(() => {
    form.unmount()
    document.body.innerHTML = ''
    setLocale('zh-CN')
  })
  let form: VueWrapper

  // they see every field in 审批数据: without the right, shown only and not sent (the stored ones stay)
  it.each([
    ['held', ['*'], false],
    ['not held', ['wf.model.view', 'wf.model.modify'], true],
  ])('the right %s', async (_, perms, locked) => {
    calls = mockApi({
      'GET /wf/models/1': ok({ ...model(1, 0), managerUserIds: [4] }),
      'GET /iam/roles/options': ok([]),
      'PUT /wf/models/1': ok(null),
    })
    useAuthStore().me = me(perms)
    form = mount(WfModelForm, {
      props: { id: 1 },
      global: {
        plugins: [ElementPlus, i18n],
        directives: { perm: vPerm },
        stubs: { DictSelect: true, IconPicker: true, WfUserIds: true, DeptTreeSelect: true },
      },
      attachTo: document.body,
    })
    await flushPromises()
    const managers = form
      .findAll('.el-form-item')
      .find((f) => f.text().startsWith(i18n.global.t('field.wf.model.managerUserIds')))!
    expect(managers.findComponent({ name: 'WfUserIds' }).props('disabled')).toBe(locked)
    expect(managers.text().includes(i18n.global.t('wf.model.form.managersLocked'))).toBe(locked)

    await form.find('.qw-dialog-footer .el-button--primary').trigger('click')
    await flushPromises()
    const put = calls.filter((c) => c.method === 'put' && c.url === '/wf/models/1')
    expect(put).toHaveLength(1)
    expect(JSON.parse(put[0]!.data as string).managerUserIds).toEqual(locked ? undefined : [4])
  })
})
