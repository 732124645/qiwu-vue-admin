// 新建审批: its save buttons check the permissions of the calls a save makes (form and model
// created or updated, then the draft or the version), and a model reopened at /wf/wizard/:id that failed to
// load is never saved (as a new one). The save steps themselves: wf-wizard-save.spec.ts. Fake backend.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { wfPerms } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import WfWizard from '@/views/workflow/admin/wizard/index.vue'
import { fail, me, mockApi, ok, type Route } from './mock-api'

// the save buttons only, the page's widgets have their own specs: mounted for real, the two designers (their
// modules alone load for a second) and the pickers made each case take 2-4 s, the file 25-40 s under load
vi.mock('@/views/platform/formkit/FormDesigner.vue', () => ({ default: { render: () => null } }))
vi.mock('@/views/workflow/designer/WfDesigner.vue', () => ({ default: { render: () => null } }))

let page: VueWrapper
/** the wizard at `path` for a user holding `perms` */
async function open(path: string, perms: string[], routes: Record<string, Route> = {}) {
  mockApi({ 'GET /iam/roles/options': ok([]), ...routes })
  useAuthStore().me = me(perms)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/wf/wizard', component: { render: () => null } },
      { path: '/wf/wizard/:id', component: { render: () => null } },
    ],
  })
  await router.push(path)
  page = mount(WfWizard, {
    global: {
      plugins: [ElementPlus, i18n, router],
      directives: { perm: vPerm },
      stubs: { DictSelect: true, IconPicker: true, WfUserIds: true, DeptTreeSelect: true },
    },
    attachTo: document.body,
  })
  await flushPromises()
}
const button = (key: string) =>
  page.findAll('.qw-page-bar button').find((b) => b.text() === i18n.global.t(key))
const draft = () => button('wf.wizard.saveDraft')
const publish = () => button('wf.wizard.publish')

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
})
afterEach(() => {
  page.unmount()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

const { model, form } = wfPerms
describe('wizard save buttons', () => {
  // a new one: the form and the model created, then the draft (model modify) or the version (publish);
  // updating rights only: nothing it could save yet
  it.each([
    ['draft only', [form.create, model.create, model.modify], [true, false]],
    ['publish only', [form.create, model.create, model.publish], [false, true]],
    ['updates only', [form.modify, model.modify, model.publish], [false, false]],
  ])('a new one, %s', async (_, perms, shown) => {
    await open('/wf/wizard', perms)
    expect([draft() !== undefined, publish() !== undefined]).toEqual(shown)
  })

  it('a model reopened: saved only once it loaded, never as a new model', async () => {
    await open('/wf/wizard/7', ['*'], { 'GET /wf/models/7': fail(403, 'A0301') })
    for (const b of [draft(), publish()]) expect(b?.attributes('disabled')).toBeDefined()
  })

  it('a model reopened and loaded: updating its form and itself is all it takes', async () => {
    const detail = {
      id: 7,
      modelKey: 'm7',
      name: 'Trip',
      category: 'other',
      icon: null,
      description: null,
      formKind: 'dynamic',
      formId: 9,
      initiatorScope: null,
      managerUserIds: null,
      allowCancel: true,
      allowWithdraw: true,
      draftJson: null,
    }
    await open('/wf/wizard/7', [model.view, model.modify, model.publish, form.view, form.modify], {
      'GET /wf/models/7': ok(detail),
      'GET /wf/forms/9': ok({ id: 9, schemaJson: { rule: [] } }),
    })
    for (const b of [draft(), publish()]) expect(b?.attributes('disabled')).toBeUndefined()
  })
})

describe('process managers', () => {
  // `wf.model.managers` changes them (they see every field in 审批数据): without it they are shown only
  it.each([
    ['held', ['*'], false],
    ['not held', [form.create, model.create, model.modify], true],
  ])('the right %s', async (_, perms, locked) => {
    await open('/wf/wizard', perms)
    const settings = page.findAll('.wf-wizard__settings').at(-1)!
    expect(settings.findComponent({ name: 'WfUserIds' }).props('disabled')).toBe(locked)
    expect(settings.text().includes(i18n.global.t('wf.model.form.managersLocked'))).toBe(locked)
    expect(settings.text()).toContain(i18n.global.t('wf.model.form.managersHint'))
  })
})
