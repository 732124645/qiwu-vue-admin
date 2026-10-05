import {
  fieldsFromFormSchema,
  WF_TEMPLATE_KEY_PREFIX,
  type FormSchema,
  type WfBeginNode,
  type WfFields,
  type WfFormCreate,
  type WfInitiatorScope,
  type WfModelCreate,
  type WfModelDetailVo,
  type WfModelVo,
} from '@qiwu/shared'
import { wfFormApi } from '@/api/workflow/form'
import { wfModelApi } from '@/api/workflow/model'
import { i18n, tx } from '@/core/i18n'
import { draftTree } from '../model-list'

/**
 * The new-approval wizard over the existing APIs: a dynamic model, its own `wf_form` and
 * its flow. Saving goes form → model → draft or version; the ids it got stay, so a retry after a failed
 * step goes on with updates instead of creating the form or the model twice.
 */

/** What the wizard edits besides the form (the designer holds that one). */
export interface Wizard {
  modelKey: string
  name: string
  category: string
  icon: string
  description: string
  initiatorScope: WfInitiatorScope
  managerUserIds: number[]
  allowCancel: boolean
  allowWithdraw: boolean
  tree: WfBeginNode
  /** reopened: a seeded name / description (a `seed.*` i18n key) → [its key, the text shown for it] */
  seeded?: Partial<Record<'name' | 'description', [key: string, text: string]>>
}

/** The ids saving got so far: set, the next save updates them. */
export interface WizardIds {
  formId?: number
  modelId?: number
}

/** The step a save failed at (`wf.wizard.step.<step>`). */
export type WizardStep = 'form' | 'model' | 'draft' | 'publish'

/** A failed save: `step` it failed at, the request's error as `cause`. */
export class WizardError extends Error {
  constructor(
    readonly step: WizardStep,
    cause: unknown,
  ) {
    super(step, { cause })
  }
}

/** A key nobody typed: the wizard does not ask for one (`^[a-z][\w-]{0,63}$`). */
export const newModelKey = () =>
  `wf-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

export const blankWizard = (beginName: string): Wizard => ({
  modelKey: newModelKey(),
  name: '',
  category: 'other',
  icon: '',
  description: '',
  initiatorScope: { userIds: [], deptIds: [], roleIds: [] },
  managerUserIds: [],
  allowCancel: true,
  allowWithdraw: true,
  tree: draftTree(null, beginName),
})

/**
 * The wizard over model `m` (and its draft): its seeded `seed.*` name and description are edited as their text
 * in the current language; reopened, each goes back as its key while its text is left as shown
 * ({@link modelBody}), a copy (a built-in template under a new key) keeps the text. Node names stay keys.
 * Without `managers` ({@link modelBody}'s) a copy takes none of its process managers (they would not be sent).
 */
export const wizardOf = (
  m: WfModelDetailVo,
  beginName: string,
  copy: boolean,
  managers = true,
): Wizard => {
  const seeded: NonNullable<Wizard['seeded']> = {}
  const text = (field: 'name' | 'description', value: string) => {
    if (!value.startsWith('seed.') || !i18n.global.te(value)) return value
    const shown = tx(value)
    if (!copy) seeded[field] = [value, shown]
    return shown
  }
  return {
    modelKey: copy ? newModelKey() : m.modelKey,
    name: text('name', m.name),
    category: m.category,
    icon: m.icon ?? '',
    description: text('description', m.description ?? ''),
    initiatorScope: m.initiatorScope ?? { userIds: [], deptIds: [], roleIds: [] },
    managerUserIds: (managers || !copy ? m.managerUserIds : null) ?? [],
    allowCancel: m.allowCancel,
    allowWithdraw: m.allowWithdraw,
    tree: draftTree(m.draftJson, beginName),
    seeded,
  }
}

/**
 * The built-in templates among `models`: dynamic models with a form under the template key prefix, not
 * drawn in BPMN (the wizard edits trees only).
 */
export const templatesOf = (models: readonly WfModelVo[]) =>
  models.filter(
    (m) =>
      m.modelKey.startsWith(WF_TEMPLATE_KEY_PREFIX) &&
      m.formKind === 'dynamic' &&
      m.flowKind !== 'bpmn' &&
      m.formId,
  )

/** The fields of a sanitized form (conditions, form-field assignees, field access); null = none derivable. */
export function fieldsOf(schema: FormSchema): WfFields | null {
  const r = fieldsFromFormSchema(schema)
  return r.ok ? r.fields : null
}

/** `wf_form.name` is unique: the model's name plus its key (set on create only, renaming is the form page's). */
export const formName = (w: Wizard) =>
  `${w.name.slice(0, 128 - w.modelKey.length - 3)} (${w.modelKey})`

/** `w[field]` as saved: a seeded one left as shown goes back as its key */
const keyed = (w: Wizard, field: 'name' | 'description') => {
  const seed = w.seeded?.[field]
  return seed && w[field] === seed[1] ? seed[0] : w[field]
}

/** `managers`: the user may change them (`wf.model.managers`); else they are not sent (`toBody`). */
export const modelBody = (w: Wizard, formId: number, managers = true): WfModelCreate => ({
  modelKey: w.modelKey,
  name: keyed(w, 'name'),
  category: w.category,
  icon: w.icon,
  description: keyed(w, 'description'),
  formKind: 'dynamic',
  formId,
  initiatorScope: w.initiatorScope,
  managerUserIds: managers ? w.managerUserIds : undefined,
  allowCancel: w.allowCancel,
  allowWithdraw: w.allowWithdraw,
})

/**
 * Saves the form, then the model, then the flow: as a draft or published as the next version (resolves with
 * it). A failure throws {@link WizardError} naming its step; `ids` keeps what was created before it.
 * `managers`: as {@link modelBody}'s.
 */
export async function saveWizard(
  w: Wizard,
  schema: FormSchema,
  ids: WizardIds,
  publish: boolean,
  managers = true,
): Promise<{ version?: number }> {
  let step: WizardStep = 'form'
  try {
    // a PUT changes what it sends: the form keeps its name
    if (ids.formId) await wfFormApi.update(ids.formId, { schemaJson: schema } as WfFormCreate)
    else {
      const form = { name: formName(w), schemaJson: schema, enabled: true }
      ids.formId = ((await wfFormApi.create(form)) as { id: number }).id
    }
    step = 'model'
    const body = modelBody(w, ids.formId, managers)
    if (ids.modelId) await wfModelApi.update(ids.modelId, body)
    else ids.modelId = ((await wfModelApi.create({ ...body, enabled: true })) as { id: number }).id
    step = publish ? 'publish' : 'draft'
    if (!publish) {
      await wfModelApi.saveDraft(ids.modelId, w.tree)
      return {}
    }
    // a dynamic model with a form: the server takes the fields from it
    return await wfModelApi.publish(ids.modelId, { tree: w.tree })
  } catch (e) {
    throw new WizardError(step, e)
  }
}
