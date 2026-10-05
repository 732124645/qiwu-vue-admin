// New-approval wizard saving: form → model → version (or draft) on a fake backend; a step
// that fails names itself and keeps the ids saved before it, so the retry updates them instead of creating
// the form or the model twice. Plus the template copy (`tpl-` models) and the template filter.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ElMessage } from 'element-plus'
import type { FormSchema, WfModelDetailVo, WfModelVo } from '@qiwu/shared'
import { setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import {
  blankWizard,
  formName,
  saveWizard,
  templatesOf,
  WizardError,
  wizardOf,
  type Wizard,
  type WizardIds,
} from '@/views/workflow/admin/wizard/wizard'
import { fail, mockApi, ok, type Route } from './mock-api'

const SCHEMA: FormSchema = { rule: [{ type: 'input', field: 'subject', title: 'Subject' }] }
const wizard = (): Wizard => ({
  ...blankWizard('Begin'),
  modelKey: 'wf-test',
  name: 'Trip',
  managerUserIds: [4],
})
const body = (c: { data?: unknown } | undefined) => JSON.parse(String(c?.data)) as unknown
const routes = (extra: Record<string, Route> = {}) => ({
  'POST /wf/forms': ok({ id: 7 }),
  'PUT /wf/forms/7': ok(null),
  'POST /wf/models': ok({ id: 3 }),
  'PUT /wf/models/3': ok(null),
  'PUT /wf/models/3/draft': ok(null),
  'POST /wf/models/3/versions': ok({ id: 11, version: 1 }),
  ...extra,
})
const sent = (calls: { method?: string; url?: string }[]) =>
  calls.map((c) => `${c.method?.toUpperCase()} ${c.url}`)

beforeEach(() => {
  setLocale('en-US')
  accessToken.value = 'at'
  vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
})
afterEach(() => vi.restoreAllMocks())

describe('saveWizard', () => {
  it('publishes a new one: the form, the model bound to it, then the version', async () => {
    const calls = mockApi(routes())
    const ids: WizardIds = {}
    const w = wizard()
    expect(await saveWizard(w, SCHEMA, ids, true)).toMatchObject({ version: 1 })
    expect(sent(calls)).toEqual(['POST /wf/forms', 'POST /wf/models', 'POST /wf/models/3/versions'])
    expect(body(calls[0])).toEqual({ name: 'Trip (wf-test)', schemaJson: SCHEMA, enabled: true })
    expect(body(calls[1])).toMatchObject({
      modelKey: 'wf-test',
      name: 'Trip',
      formKind: 'dynamic',
      formId: 7,
      managerUserIds: [4],
      allowCancel: true,
      allowWithdraw: true,
      enabled: true,
    })
    // the server takes a bound form's fields itself
    expect(body(calls[2])).toEqual({ tree: w.tree })
    expect(ids).toEqual({ formId: 7, modelId: 3 })
  })

  it('without the right to change them, the process managers are not sent', async () => {
    const calls = mockApi(routes())
    await saveWizard(wizard(), SCHEMA, {}, false, false)
    expect(sent(calls)[1]).toBe('POST /wf/models')
    expect(body(calls[1])).not.toHaveProperty('managerUserIds')
  })

  it('a failed publish keeps both ids: the retry updates form and model, then publishes', async () => {
    let first = true
    const publish: Route = () => {
      const r = first ? fail(400, 'A0400', 'node X has no reviewer') : ok({ id: 11, version: 1 })
      first = false
      return r
    }
    const calls = mockApi(routes({ 'POST /wf/models/3/versions': publish }))
    const ids: WizardIds = {}
    const error = await saveWizard(wizard(), SCHEMA, ids, true).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(WizardError)
    expect((error as WizardError).step).toBe('publish')
    expect((error as WizardError).cause).toMatchObject({ status: 400 })
    expect(ids).toEqual({ formId: 7, modelId: 3 })

    calls.length = 0
    await saveWizard(wizard(), SCHEMA, ids, true)
    expect(sent(calls)).toEqual([
      'PUT /wf/forms/7',
      'PUT /wf/models/3',
      'POST /wf/models/3/versions',
    ])
    // a PUT keeps the form's name and the model's enabled flag
    expect(body(calls[0])).toEqual({ schemaJson: SCHEMA })
    expect(body(calls[1])).not.toHaveProperty('enabled')
  })

  it('a failed model create names the model step and keeps only the form', async () => {
    let first = true
    const create: Route = () => {
      const r = first ? fail(400, 'A0400') : ok({ id: 3 })
      first = false
      return r
    }
    const calls = mockApi(routes({ 'POST /wf/models': create }))
    const ids: WizardIds = {}
    const error = await saveWizard(wizard(), SCHEMA, ids, false).catch((e: unknown) => e)
    expect((error as WizardError).step).toBe('model')
    expect(ids).toEqual({ formId: 7 })
    calls.length = 0
    expect(await saveWizard(wizard(), SCHEMA, ids, false)).toEqual({})
    expect(sent(calls)).toEqual(['PUT /wf/forms/7', 'POST /wf/models', 'PUT /wf/models/3/draft'])
  })

  it('a failed form names the form step and creates nothing else', async () => {
    const calls = mockApi(routes({ 'POST /wf/forms': fail(400, 'A0400') }))
    const ids: WizardIds = {}
    const error = await saveWizard(wizard(), SCHEMA, ids, true).catch((e: unknown) => e)
    expect((error as WizardError).step).toBe('form')
    expect(sent(calls)).toEqual(['POST /wf/forms'])
    expect(ids).toEqual({})
  })
})

describe('templates', () => {
  const template = {
    id: 9,
    modelKey: 'tpl-leave',
    name: 'seed.wf.tpl.leave',
    description: 'seed.wf.tpl.leaveDescription',
    category: 'hr',
    icon: 'lucide:calendar-days',
    formKind: 'dynamic',
    formId: 5,
    initiatorScope: null,
    managerUserIds: null,
    allowCancel: true,
    allowWithdraw: false,
    enabled: false,
    draftJson: { id: 'begin', type: 'begin', name: 'seed.wf.node.begin' },
  } as unknown as WfModelDetailVo

  it('a copy: a new key, the seeded name and description as text, the draft as it is', () => {
    const w = wizardOf(template, 'Begin', true)
    expect(w.modelKey).not.toBe('tpl-leave')
    expect(w.modelKey).toMatch(/^[a-z][\w-]{0,63}$/)
    expect(w).toMatchObject({
      name: 'Leave',
      category: 'hr',
      icon: 'lucide:calendar-days',
      initiatorScope: { userIds: [], deptIds: [], roleIds: [] },
      managerUserIds: [],
      allowWithdraw: false,
      tree: { id: 'begin', name: 'seed.wf.node.begin' },
    })
    expect(w.description).toMatch(/^Days computed/)
    // reopened (not a copy): the model's own key, its seeded name shown as text too
    const reopened = wizardOf(template, 'Begin', false)
    expect(reopened).toMatchObject({ modelKey: 'tpl-leave', name: 'Leave' })
    expect(reopened.description).toBe(w.description)
    // a copy takes the process managers only with the right to change them; reopened: its own
    const managed = { ...template, managerUserIds: [4] }
    expect(wizardOf(managed, 'Begin', true).managerUserIds).toEqual([4])
    expect(wizardOf(managed, 'Begin', true, false).managerUserIds).toEqual([])
    expect(wizardOf(managed, 'Begin', false, false).managerUserIds).toEqual([4])
  })

  it('reopened: a seeded name or description left as shown is saved as its key, an edited one as text', async () => {
    const calls = mockApi(routes())
    const w = wizardOf(template, 'Begin', false)
    await saveWizard(w, SCHEMA, { formId: 7, modelId: 3 }, false)
    expect(body(calls[1])).toMatchObject({
      name: 'seed.wf.tpl.leave',
      description: 'seed.wf.tpl.leaveDescription',
    })
    calls.length = 0
    w.name = 'Annual leave'
    await saveWizard(w, SCHEMA, { formId: 7, modelId: 3 }, false)
    expect(body(calls[1])).toMatchObject({
      name: 'Annual leave',
      description: 'seed.wf.tpl.leaveDescription',
    })
    // a copy saves the text: the new model is not seeded
    calls.length = 0
    await saveWizard(wizardOf(template, 'Begin', true), SCHEMA, {}, false)
    expect(body(calls[1])).toMatchObject({ name: 'Leave' })
  })

  it('templates: dynamic tree models with a form under the tpl- prefix', () => {
    const rows = [
      template,
      { ...template, id: 10, modelKey: 'leave-tpl-x' },
      { ...template, id: 11, formId: null },
      { ...template, id: 12, formKind: 'custom' },
      { ...template, id: 13, flowKind: 'bpmn' },
    ] as WfModelVo[]
    expect(templatesOf(rows).map((m) => m.id)).toEqual([9])
  })

  it('the form name stays within 128 characters', () => {
    const name = formName({ ...wizard(), name: 'x'.repeat(128) })
    expect(name).toHaveLength(128)
    expect(name.endsWith(' (wf-test)')).toBe(true)
  })
})
