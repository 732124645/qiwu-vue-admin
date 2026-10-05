// Instance detail actions (see docs/design-notes.md#workflow): a remove-sign takes one of the caller's tasks' pending
// add-signs, never a mix of two tasks (the server's POST /wf/tasks/:id/remove-sign wants that task's). Sent
// back to the initiator (a `begin` task): a dynamic form resubmits through the dialog, a custom one opens its
// business page (the route of its view component). The progress tree: the read-only designer over the
// version's tree, each step as the instance stands there. The dialogs and the rest run in Playwright
// (wf-center-extra.spec.ts, leave.spec.ts). Against a fake backend.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import type { WfInstanceDetailVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import WfInstanceDetail from '@/views/workflow/center/detail.vue'
import { mockApi, ok } from './mock-api'

const openDialog = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<true | undefined>>())
vi.mock('@/core/dialog', () => ({ openDialog }))

const sign = (id: number, parentTaskId: number, name: string) => ({
  id,
  parentTaskId,
  nodeName: `Step ${parentTaskId}`,
  user: { id: id + 100, name },
})
const DETAIL: WfInstanceDetailVo = {
  id: 40,
  modelKey: 'e2e',
  modelName: 'E2E',
  title: 'E2E-Admin-2026-09-30',
  formKind: 'dynamic',
  viewComponent: null,
  businessKey: null,
  state: 'running',
  initiator: { id: 2, name: 'Bob' },
  startedAt: '2026-09-30T01:00:00.000Z',
  endedAt: null,
  myTasks: [],
  // two tasks of mine on parallel paths, both before-signed
  signs: [sign(7, 5, 'Ann'), sign(8, 6, 'Cid'), sign(9, 5, 'Dee')],
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
}

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  openDialog.mockReset()
})
afterEach(() => {
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

const blank = { render: () => null }
/**
 * vi.waitFor's ceiling: its 1 s default is wall clock that the renders it waits through (the page, form-create's
 * timer-driven ones) use up on a loaded machine; still under the test's own timeout, to report the last miss
 */
const RENDERED = { timeout: 10_000 }
/** The detail of `detail` at /workflow/instances/40, once it shows button `label`; its page and router. */
async function open(detail: WfInstanceDetailVo, label: string, routes: object = {}) {
  mockApi({ 'GET /wf/instances/40': ok(detail), ...routes })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/workflow/instances/:id', component: blank },
      // a menu page's route carries its view (build-routes)
      { path: '/biz/leave/:id', component: blank, meta: { component: 'biz/leave/view' } },
    ],
  })
  await router.push('/workflow/instances/40')
  const page = mount(WfInstanceDetail, { global: { plugins: [ElementPlus, i18n, router] } })
  await vi.waitFor(async () => {
    await flushPromises()
    expect(page.findAll('button').some((b) => b.text() === label)).toBe(true)
  }, RENDERED)
  return { page, router, button: () => page.findAll('button').find((b) => b.text() === label)! }
}

const BEGIN = {
  id: 3,
  nodeId: 'begin',
  nodeName: 'Begin',
  type: 'begin' as const,
  commentRequired: false,
  child: false,
}
const texts = (page: { findAll(s: string): { text(): string }[] }) =>
  page.findAll('.wf-detail__actions button').map((b) => b.text())

describe('instance detail', () => {
  it('the progress tree: the version tree, read-only, each step by its progress', async () => {
    const detail: WfInstanceDetailVo = {
      ...DETAIL,
      tree: {
        id: 'begin',
        type: 'begin',
        name: 'Begin',
        next: {
          id: 'check',
          type: 'review',
          name: 'Check',
          assignee: { kind: 'initiatorDeptHead' },
          sign: 'any',
          whenNobody: 'toManager',
          whenInitiatorIsReviewer: 'self',
          onReject: 'finish',
        },
      },
      progress: { begin: 'done', check: 'active' },
    }
    const { page } = await open(detail, i18n.global.t('wf.center.decide.removeSign'))
    const tree = page.find('.wf-detail__progress')
    expect(tree.find('.el-card__header').text()).toBe(i18n.global.t('wf.center.detail.progress'))
    const cards = tree.findAll('[data-node-id]')
    expect(cards.map((c) => [c.attributes('data-node-id'), c.attributes('data-progress')])).toEqual(
      [
        ['begin', 'done'],
        ['check', 'active'],
      ],
    )
    expect(tree.findAll('button')).toHaveLength(0)
    page.unmount()
  })

  it("the progress tree words conditions by the version's fields: user ids as a count, as the editor does", async () => {
    const detail: WfInstanceDetailVo = {
      ...DETAIL,
      fields: { applicant: 'user' },
      tree: {
        id: 'begin',
        type: 'begin',
        name: 'Begin',
        next: {
          id: 'f',
          type: 'fork',
          name: 'Fork',
          paths: [
            { id: 'pa', name: 'Them', when: [[{ field: 'applicant', op: 'in', value: [5, 6] }]] },
            { id: 'pz', name: 'Else', fallback: true, when: [] },
          ],
        },
      },
      progress: { begin: 'done', f: 'active', pa: 'active', pz: 'skipped' },
    }
    const { page } = await open(detail, i18n.global.t('wf.center.decide.removeSign'))
    const { t } = i18n.global
    expect(page.find('.wf-detail__progress [data-node-id="pa"] .wf-card__body').text()).toBe(
      `applicant ${t('wf.designer.op.in')} ${t('wf.designer.summary.count', 2)}`,
    )
    page.unmount()
  })

  it('a version whose tree no longer compiles (tree null): no progress card, the timeline stays', async () => {
    const { page } = await open(
      { ...DETAIL, tree: null, progress: null },
      i18n.global.t('wf.center.decide.removeSign'),
    )
    expect(page.find('.wf-detail__progress').exists()).toBe(false)
    expect(page.text()).toContain(i18n.global.t('wf.center.detail.timeline'))
    page.unmount()
  })

  it("remove-sign: the first task's pending add-signs only, on that task", async () => {
    const label = i18n.global.t('wf.center.decide.removeSign')
    const { page, button } = await open(DETAIL, label)
    await button().trigger('click')
    expect(openDialog.mock.calls[0]?.[1]).toEqual({
      id: 5,
      action: 'removeSign',
      commentRequired: undefined,
      signs: [DETAIL.signs[0], DETAIL.signs[2]],
    })
    page.unmount()
  })

  it('sent back, a dynamic form: resubmit its begin task through the dialog, or cancel', async () => {
    const sent = { ...DETAIL, signs: [], myTasks: [BEGIN], canCancel: true }
    const { t } = i18n.global
    const { page, button } = await open(sent, t('wf.center.decide.resubmit'))
    expect(texts(page)).toEqual([
      t('wf.center.decide.resubmit'),
      t('wf.center.decide.cancel'),
      t('wf.center.detail.print'),
    ])
    await button().trigger('click')
    expect(openDialog.mock.calls[0]?.[1]).toMatchObject({ id: BEGIN.id, action: 'resubmit' })
    page.unmount()
  })

  it("a dynamic form by the caller's access: read fields disabled, approve sends the edit fields", async () => {
    const review = {
      ...BEGIN,
      id: 5,
      nodeId: 'review',
      nodeName: 'Review',
      type: 'review' as const,
    }
    const detail: WfInstanceDetailVo = {
      ...DETAIL,
      signs: [],
      myTasks: [review],
      // the server left out the `hide` field (rule and value)
      schema: {
        rule: [
          { type: 'input', field: 'reason', title: 'Reason', $required: true },
          { type: 'inputNumber', field: 'amount', title: 'Amount' },
          { type: 'qw-user-select', field: 'lead', title: 'Lead' },
        ],
      },
      formValues: { reason: 'trip', amount: 5, lead: 9 },
      access: { amount: 'edit' },
    }
    const { t } = i18n.global
    const users = ok([{ id: 9, displayName: 'Lia', deptName: null }])
    const { page, button } = await open(detail, t('wf.center.decide.approve'), {
      'GET /wf/users/options': users,
    })
    await vi.waitFor(async () => {
      await flushPromises()
      expect(page.findAll('.wf-detail__form input')).toHaveLength(3)
    }, RENDERED)
    const [reason, amount, lead] = page
      .findAll('.wf-detail__form input')
      .map((w) => w.element as HTMLInputElement)
    expect([reason!.disabled, amount!.disabled, lead!.disabled]).toEqual([true, false, true])
    expect(reason!.value).toBe('trip')
    // a user field reads by name, not `#9`
    expect(lead!.value).toBe('Lia')
    await button().trigger('click')
    await vi.waitFor(() => expect(openDialog).toHaveBeenCalled(), RENDERED)
    expect(openDialog.mock.calls[0]?.[1]).toMatchObject({
      id: 5,
      action: 'approve',
      formValues: { amount: 5 },
    })
    page.unmount()
  })

  it("a reader's calc fields keep the server's values; dept names; column labels in the form's language", async () => {
    const date = (field: string) => ({
      type: 'datePicker' as const,
      field,
      props: { type: 'date', valueFormat: 'YYYY-MM-DD' },
    })
    const detail: WfInstanceDetailVo = {
      ...DETAIL,
      // the server left out the dates hidden from this reader (rules and values)
      schema: {
        rule: [
          date('start'),
          date('end'),
          {
            type: 'qw-date-range-days',
            field: 'days',
            props: { startField: 'start', endField: 'end' },
          },
          { type: 'qw-dept-select', field: 'dept' },
          {
            type: 'qw-detail-table',
            field: 'items',
            props: {
              columns: [
                { prop: 'kind', label: '{{$t.itemKind}}' },
                { prop: 'amount', label: '{{ $t.amount }}', sum: 'total' },
              ],
            },
          },
        ],
        option: {
          language: {
            'zh-cn': { itemKind: '费用类型', amount: '金额' },
            en: { itemKind: 'Type', amount: 'Amount' },
          },
        },
      },
      formValues: {
        days: 4,
        dept: 3,
        items: JSON.stringify([{ kind: 'Taxi', amount: 12.5 }]),
        total: 12.5,
      },
      access: { start: 'hide', end: 'hide' },
    }
    const { page } = await open(detail, i18n.global.t('wf.center.decide.removeSign'), {
      'GET /wf/depts/options': ok([{ id: 3, name: 'HQ', children: [] }]),
    })
    const days = () => page.find('.wf-detail__form .el-input-group input').element
    await vi.waitFor(async () => {
      await flushPromises()
      expect(page.find('.wf-detail__form .el-select__placeholder').text()).toBe('HQ')
    }, RENDERED)
    // not recomputed from dates it does not have (nor were they there: read-only)
    expect((days() as HTMLInputElement).value).toBe('4')
    const heads = () => page.findAll('.wf-detail__form .el-table__header th').map((th) => th.text())
    expect(heads()).toEqual(['Type', 'Amount'])
    expect(page.findAll('.el-table__footer td').map((td) => td.text())).toEqual(['Total', '12.5'])

    // zh-CN: the page reloads, the labels in the form's own zh-cn texts
    setLocale('zh-CN')
    await vi.waitFor(async () => {
      await flushPromises()
      expect(heads()).toEqual(['费用类型', '金额'])
    }, RENDERED)
    expect((days() as HTMLInputElement).value).toBe('4')
    page.unmount()
  })

  it("sent back, a custom form: its business page (the view's route, :id = the business key)", async () => {
    const sent: WfInstanceDetailVo = {
      ...DETAIL,
      formKind: 'custom',
      viewComponent: 'biz/leave/view',
      businessKey: '12',
      signs: [],
      myTasks: [BEGIN],
      canCancel: true,
    }
    const { t } = i18n.global
    const { page, router, button } = await open(sent, t('wf.center.decide.editResubmit'))
    expect(texts(page)).toEqual([
      t('wf.center.decide.editResubmit'),
      t('wf.center.decide.cancel'),
      t('wf.center.detail.print'),
    ])
    await button().trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/biz/leave/12')
    expect(openDialog).not.toHaveBeenCalled()
    page.unmount()
  })
})
