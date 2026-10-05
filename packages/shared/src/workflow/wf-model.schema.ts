import { z } from 'zod'
import { pageQuery } from '../common/pagination.js'
import { formSchema } from '../platform/formkit/form-schema.js'
import { fieldDomains } from '../validation/zod-i18n.js'
import { wfFields } from './wf.schema.js'

/**
 * Process models (`wf_model`) and their published versions (`wf_version`), `/api/wf/models` (see docs/design-notes.md#workflow), behind `wfPerms.model`. Field labels `field.wf.model.<prop>`.
 */

/** `dynamic`: a form-create form; `custom`: a business page with its `WfBusinessHandler` (leave). */
export const WF_FORM_KINDS = ['dynamic', 'custom'] as const
export type WfFormKind = (typeof WF_FORM_KINDS)[number]

/**
 * How the process is drawn: `tree` in the node-tree designer (`draft_json`), `bpmn` as a BPMN
 * diagram (`draft_xml`) the server compiles to the same tree on publish. Chosen on create, never changes.
 */
export const WF_FLOW_KINDS = ['tree', 'bpmn'] as const
export type WfFlowKind = (typeof WF_FLOW_KINDS)[number]

/** Longest BPMN XML (UTF-8 bytes; about 90 elements): fits the global 100 KB JSON body limit. */
export const WF_BPMN_XML_MAX = 80 * 1024
/** A BPMN XML as a body takes it: characters here, bytes checked by `bpmnPrecheck`. */
const bpmnXml = z.string().max(WF_BPMN_XML_MAX)

/**
 * `modelKey` prefix of the built-in templates: dynamic models seeded with their forms,
 * disabled and unpublished, for the new-approval wizard to copy ("from template").
 */
export const WF_TEMPLATE_KEY_PREFIX = 'tpl-'

const id = z.number().int().positive()
const ids = z.array(id).max(200)
/** A SPA route the start page opens (`/biz/leave/new`): path segments only, no scheme or query. */
const route = z
  .string()
  .trim()
  .max(255)
  .regex(/^(\/[\w-]+)+$/)
/** A `views`-relative component path (`biz/leave/view`) the web loads through `import.meta.glob`. */
const component = z
  .string()
  .trim()
  .max(255)
  .regex(/^[\w-]+(\/[\w-]+)*$/)

/**
 * Who may start the model: any listed user, member of a listed dept or of a dept below it, or holder of a
 * listed (enabled) role. null = everyone; a scope listing nobody is stored as null (it would lock everyone
 * out).
 */
export const wfInitiatorScope = z.preprocess(
  (v) =>
    v && typeof v === 'object' && Object.values(v).every((l) => Array.isArray(l) && !l.length)
      ? null
      : v,
  z
    .object({ userIds: ids.default([]), deptIds: ids.default([]), roleIds: ids.default([]) })
    .nullish(),
)
export type WfInitiatorScope = NonNullable<z.output<typeof wfInitiatorScope>>

const base = z.object({
  /** registry key of the business handler (custom) and of every version / instance; never changes */
  modelKey: z
    .string()
    .trim()
    .regex(/^[a-z][\w-]{0,63}$/),
  name: z.string().trim().min(1).max(128),
  /** dict `wf.category` */
  category: z.string().trim().min(1).max(24).optional(),
  icon: z.string().trim().max(64).nullish(),
  description: z.string().trim().max(500).nullish(),
  /** never changes (a version's form snapshot and the start rules depend on it) */
  formKind: z.enum(WF_FORM_KINDS),
  /** never changes; none = `tree` */
  flowKind: z.enum(WF_FLOW_KINDS).optional(),
  /** a dynamic model's form (`wf_form`, live → else 404): publishing snapshots it and takes its fields */
  formId: id.nullish(),
  createRoute: route.nullish(),
  viewComponent: component.nullish(),
  initiatorScope: wfInitiatorScope,
  /** where `whenNobody: 'toManager'` goes */
  managerUserIds: ids.optional(),
  /** the initiator may cancel a running instance */
  allowCancel: z.boolean().optional(),
  /** an approver may take back an approval nobody acted on yet */
  allowWithdraw: z.boolean().optional(),
  enabled: z.boolean().optional(),
  sortNo: z.number().int().min(0).max(999_999).optional(),
})

/** POST body: a `custom` model needs its start route and view component. */
export const wfModelCreate = base
  .superRefine((m, ctx) => {
    if (m.formKind !== 'custom') return
    for (const key of ['createRoute', 'viewComponent'] as const)
      if (!m[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'validation.required' })
  })
  .register(fieldDomains, { domain: 'wf.model' })
export type WfModelCreate = z.infer<typeof wfModelCreate>

/**
 * PUT body: the fields sent change; `modelKey`, `formKind` and `flowKind` stay, the custom page paths cannot
 * be cleared.
 */
export const wfModelUpdate = base
  .omit({ modelKey: true, formKind: true, flowKind: true })
  .extend({ createRoute: route.optional(), viewComponent: component.optional() })
  .partial()
  .register(fieldDomains, { domain: 'wf.model' })
export type WfModelUpdate = z.infer<typeof wfModelUpdate>

export const wfModelQuery = pageQuery(['sortNo', 'name', 'modelKey', 'createdAt', 'id'])
  .extend({
    modelKey: z.string().trim().max(64).optional(),
    name: z.string().trim().max(128).optional(),
    category: z.string().trim().max(24).optional(),
    enabled: z.stringbool().optional(),
  })
  .register(fieldDomains, { domain: 'wf.model' })
export type WfModelQuery = z.output<typeof wfModelQuery>

/** PUT /sort: new sort numbers of several models at once (all or nothing). */
export const wfModelSortBody = z
  .object({
    items: z
      .array(z.object({ id, sortNo: z.number().int().min(0).max(999_999) }))
      .min(1)
      .max(200),
  })
  .register(fieldDomains, { domain: 'wf.model' })
export type WfModelSortBody = z.infer<typeof wfModelSortBody>

/**
 * PUT /:id/draft: the designer's work in progress, checked on publish — a tree model's tree-shaped object or
 * a BPMN model's XML, never both.
 */
export const wfDraftBody = z
  .union([
    z.object({ tree: z.record(z.string(), z.unknown()) }).strict(),
    z.object({ xml: bpmnXml }).strict(),
  ])
  .register(fieldDomains, { domain: 'wf.model' })
export type WfDraftBody = z.infer<typeof wfDraftBody>

/**
 * POST /:id/versions: publishes `tree` (a JSON import; `xml` for a BPMN model) or, without it, the saved
 * draft, after `compile`
 * against the form's fields: a dynamic model's bound form's (`fieldsFromFormSchema`), a custom one's
 * business handler's; `fields` is read only for a dynamic model without a form (synthetic snapshot).
 */
export const wfPublishBody = z
  .object({ tree: z.unknown().optional(), xml: bpmnXml.optional(), fields: wfFields.optional() })
  .register(fieldDomains, { domain: 'wf.model' })
export type WfPublishBody = z.infer<typeof wfPublishBody>

export const wfModelVo = z.object({
  id: z.number().int(),
  modelKey: z.string(),
  name: z.string(),
  category: z.string(),
  icon: z.string().nullable(),
  description: z.string().nullable(),
  formKind: z.enum(WF_FORM_KINDS),
  flowKind: z.enum(WF_FLOW_KINDS),
  formId: z.number().int().nullable(),
  createRoute: z.string().nullable(),
  viewComponent: z.string().nullable(),
  initiatorScope: z
    .object({
      userIds: z.array(z.number()),
      deptIds: z.array(z.number()),
      roleIds: z.array(z.number()),
    })
    .nullable(),
  managerUserIds: z.array(z.number()).nullable(),
  allowCancel: z.boolean(),
  allowWithdraw: z.boolean(),
  enabled: z.boolean(),
  sortNo: z.number().int(),
  /** null = never published */
  currentVersionId: z.number().int().nullable(),
  createdBy: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
  updatedBy: z.number().int().nullable(),
  updatedAt: z.iso.datetime(),
})
export type WfModelVo = z.infer<typeof wfModelVo>

/** GET /:id: + the draft and the fields the designer builds conditions from (custom: the handler's). */
export const wfModelDetailVo = wfModelVo.extend({
  /** a tree model's draft */
  draftJson: z.record(z.string(), z.unknown()).nullable(),
  /** a BPMN model's draft (the normalized XML once published) */
  draftXml: z.string().nullable(),
  /** the bound form's (dynamic) or the handler's (custom); null = none (no form / no registered handler) */
  fields: wfFields.nullable(),
})
export type WfModelDetailVo = z.infer<typeof wfModelDetailVo>

/**
 * What a version runs on: its form's `fields` and, for a dynamic model with a form, that form's schema as
 * published (sanitized again on publish).
 */
export const wfFormSnapshot = z.object({ fields: wfFields, schema: formSchema.optional() })
export type WfFormSnapshot = z.infer<typeof wfFormSnapshot>

/** GET /:id/versions: newest first. */
export const wfVersionVo = z.object({
  id: z.number().int(),
  version: z.number().int(),
  formSnapshot: wfFormSnapshot,
  /** null = seeded */
  publishedBy: z.number().int().nullable(),
  publishedAt: z.iso.datetime(),
})
export type WfVersionVo = z.infer<typeof wfVersionVo>

/**
 * GET /:id/versions/:versionId: + the published (compiled) tree, for the JSON export, and a BPMN
 * model's normalized XML it was compiled from (null: a tree model's version).
 */
export const wfVersionDetailVo = wfVersionVo.extend({
  tree: z.record(z.string(), z.unknown()),
  bpmnXml: z.string().nullable(),
})
export type WfVersionDetailVo = z.infer<typeof wfVersionDetailVo>
