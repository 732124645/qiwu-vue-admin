// Approval lists: the approval tab's to-dos, done, started and copied lists over the approval-center
// APIs (sign-in only, the caller's own rows; no mobile endpoints), each item as one row shape the
// page renders; the instance detail's form page and timeline targets; what the caller may do on it. Here so
// vitest runs it without the uni compiler.
import {
  type DictPayload,
  type ObjectSchema,
  type Page,
  type ValidationIssue,
  type WfBackTargetVo,
  type WfCcItemVo,
  type WfInstanceDetailVo,
  type WfInstanceItemVo,
  type WfSignKind,
  type WfStartableVo,
  type WfStartInfoVo,
  type WfStartVo,
  type WfTaskItemVo,
  wfAddSignBody,
  wfCcBody,
  wfCommentBody,
  wfHandOverBody,
  wfRemarkBody,
  wfRemoveSignBody,
  wfSendBackBody,
} from '@qiwu/shared'
import { MOBILE_FORMS } from './views'
import { formatTime } from './format'
import { t, tx } from './i18n'
import { choiceText, dictChoices, loadDict, type PickedUser } from './pickers'
import { api } from './request'
import { hasPerm } from './stores/auth'
import { useCountsStore } from './stores/counts'

export const APPROVAL_LISTS = ['todo', 'done', 'mine', 'cc'] as const
export type ApprovalList = (typeof APPROVAL_LISTS)[number]

export type StateDict = 'wf.task_state' | 'wf.instance_state'

/** A row of any list: what the page shows and what a tap opens. */
export interface ApprovalRow {
  /** the task, instance or copy id (unique within its list) */
  id: number
  instanceId: number
  /** The row's title (a seeded one is a key, `tx()`; the server's instance title is not shown) */
  modelName: string
  /** Who started it (null: the user is gone), their id (the avatar's colour) */
  initiator: string | null
  initiatorId: number
  /** arrived (todo), handled (done), started (mine), sent (cc) */
  at: string | null
  /** the step; a seeded one is a key (`tx()`) */
  node?: string
  /** cc: who sent the copy, null = a notify step of the process */
  from?: string | null
  /** dict-coded states, shown as tags */
  tags: { dict: StateDict; value: string }[]
  /** done: my comment; cc: the note */
  note: string | null
  /** cc: not read yet */
  unread?: boolean
}

interface Items {
  todo: WfTaskItemVo
  done: WfTaskItemVo
  mine: WfInstanceItemVo
  cc: WfCcItemVo
}

/** The instance's part of a row. */
const of = (x: WfInstanceItemVo) => ({
  instanceId: x.id,
  modelName: x.modelName,
  initiator: x.initiator.name,
  initiatorId: x.initiator.id,
})

const LISTS: { [K in ApprovalList]: { url: string; row: (x: Items[K]) => ApprovalRow } } = {
  todo: {
    url: '/wf/tasks/todo',
    row: (x) => ({
      id: x.id,
      ...of(x.instance),
      at: x.createdAt,
      node: x.nodeName,
      tags: [],
      note: null,
    }),
  },
  done: {
    url: '/wf/tasks/done',
    row: (x) => ({
      id: x.id,
      ...of(x.instance),
      at: x.handledAt,
      node: x.nodeName,
      tags: [
        { dict: 'wf.task_state', value: x.state },
        { dict: 'wf.instance_state', value: x.instance.state },
      ],
      note: x.comment,
    }),
  },
  mine: {
    url: '/wf/instances/mine',
    row: (x) => ({
      id: x.id,
      ...of(x),
      at: x.startedAt,
      tags: [{ dict: 'wf.instance_state', value: x.state }],
      note: null,
    }),
  },
  cc: {
    url: '/wf/ccs/mine',
    row: (x) => ({
      id: x.id,
      ...of(x.instance),
      at: x.createdAt,
      from: x.fromUser ? (x.fromUser.name ?? '') : null,
      tags: [],
      note: x.reason,
      unread: !x.readAt,
    }),
  },
}

/**
 * A page of `list`, newest first (the server's default sort). A to-do page's total is my to-do count: it
 * updates the count the workbench and the tab badge share without waiting for their poll.
 */
export async function loadApprovals<K extends ApprovalList>(
  list: K,
  page: number,
  pageSize: number,
): Promise<Page<ApprovalRow>> {
  const { url, row } = LISTS[list] as { url: string; row: (x: Items[K]) => ApprovalRow }
  const res = await api.get<Page<Items[K]>>(url, { page, pageSize })
  if (list === 'todo') useCountsStore().todo = res.total
  return { items: res.items.map(row), total: res.total }
}

/** The avatar colours, by user id (§12.4). */
const TONES = ['brand', 'success', 'warning', 'neutral'] as const

/**
 * A person's avatar (§12.4): the first letter of their name, upper-cased ('?' when gone; `id` null: the
 * system, neutral) and a colour by their id.
 */
export function avatar(name: string | null | undefined, id: number | null) {
  const first = Array.from(name ?? '')[0] ?? '?'
  return { text: first.toUpperCase(), tone: id === null ? 'neutral' : TONES[Math.abs(id) % 4]! }
}

/** POST /wf/ccs/:id/read: my copy read (reading it again keeps the first time). */
export const readCc = (id: number) => api.post<null>(`/wf/ccs/${id}/read`)

/** the `.qw-tag--*` colours the dicts' `tagType` may name; the rest (`info`, none) show neutral (`info`). */
const TAG_TYPES = new Set(['primary', 'success', 'warning', 'danger'])

/** A state as a `.qw-tag` pill: its dict label in the current language (else the code) and colour. */
export function stateTag(dict: DictPayload | undefined, value: string) {
  const type = dict?.entries.find((e) => e.value === value)?.tagType ?? ''
  return {
    label: choiceText(dictChoices(dict), value),
    type: (TAG_TYPES.has(type) ? type : 'info') as 'primary' | 'success' | 'warning' | 'danger' | 'info',
  }
}

// ---- detail -----------------------------------------------------------------------------------------------

/** GET /wf/instances/:id: an instance the caller may see (see docs/design-notes.md#workflow), else 404, which the page shows. */
export const loadInstance = (id: number) => api.get<WfInstanceDetailVo>(`/wf/instances/${id}`)

type FormOf = Pick<WfInstanceDetailVo, 'formKind' | 'viewComponent' | 'businessKey'>
const mobileForm = (inst: FormOf) =>
  inst.formKind === 'custom' && inst.businessKey
    ? MOBILE_FORMS.find((f) => f.viewComponent === inst.viewComponent)
    : undefined

/**
 * The page showing an instance's business document: a custom form's, when the mobile view registry
 * maps its `view_component`; null = none (unmapped: viewed on the desktop; a dynamic form renders on the detail).
 */
export function formPage(inst: FormOf): string | null {
  const f = mobileForm(inst)
  return f ? `${f.view}?id=${encodeURIComponent(inst.businessKey!)}&readonly=1` : null
}

/** A model's icon: the view registry's, by its view (detail) or create route (start); else `doc`. */
export const modelIcon = (m: { viewComponent?: string | null; createRoute?: string | null }) =>
  MOBILE_FORMS.find((f) =>
    m.createRoute ? f.createRoute === m.createRoute : f.viewComponent === m.viewComponent,
  )?.icon ?? 'doc'

/** The key fields of an instance's document, each a label and its text in the current language. */
export interface FormSummary {
  title: string
  rows: { label: string; value: string }[]
}

/**
 * A mapped custom form's summary (the registry's `summary`): its document (GET, silent), dict values as
 * their labels, times local; null = none (unmapped, no summary, or the document did not load): the detail
 * keeps its one "form · view" row.
 */
export async function loadSummary(inst: FormOf): Promise<FormSummary | null> {
  const s = mobileForm(inst)?.summary
  if (!s) return null
  try {
    const url = s.url.replace(':id', encodeURIComponent(inst.businessKey!))
    const [doc, dicts] = await Promise.all([
      api.get<Record<string, unknown>>(url, undefined, { silent: true }),
      Promise.all(
        s.fields.map((f) => (f.dict ? loadDict(f.dict).catch(() => undefined) : undefined)),
      ),
    ])
    const text = (v: unknown, i: number) => {
      const f = s.fields[i]!
      if (v === null || v === undefined || v === '') return ''
      if (f.time) return formatTime(String(v))
      return f.dict ? choiceText(dictChoices(dicts[i]), String(v)) : String(v)
    }
    return {
      title: t(s.title),
      rows: s.fields.map((f, i) => ({
        label: t(`${s.labels}.${f.prop}`),
        value: text(doc[f.prop], i),
      })),
    }
  } catch {
    return null
  }
}

/**
 * Sent back to its initiator (their `begin` task `taskId`): the page editing a mapped custom form's document,
 * which resubmits it; null = resubmitted as it is (a dynamic form, an unmapped custom one, or no edit perm).
 */
export function editPage(inst: FormOf, taskId: number): string | null {
  const f = mobileForm(inst)
  return f && hasPerm(f.modify)
    ? `${f.form}?id=${encodeURIComponent(inst.businessKey!)}&task=${taskId}`
    : null
}

/** A timeline event's targets: users by name, a send-back's step by its name (`tx()`), else the id. */
export const targetNames = (e: WfInstanceDetailVo['timeline'][number]) =>
  e.targets.map((x) => (x.name ? tx(x.name) : String(x.id))).join(', ')

// ---- actions (decisions, routing, signs, cc, comment, withdraw, cancel, urge) -------------------------------

/**
 * An action through the decision sheet (动作语义, the workflow APIs; see docs/design-notes.md#workflow): on my pending review task, on my
 * add-signs still pending (removeSign), on my newest approval (withdraw), on my `begin` task (resubmit: sent
 * back to me, the initiator), on my instance (cancel). `urge` posts nothing but itself.
 */
export type WfDecision =
  | 'approve'
  | 'reject'
  | 'sendBack'
  | 'transfer'
  | 'delegate'
  | 'addSign'
  | 'cc'
  | 'comment'
  | 'removeSign'
  | 'withdraw'
  | 'resubmit'
  | 'cancel'
export type WfAction = WfDecision | 'urge'
export type WfMyTask = WfInstanceDetailVo['myTasks'][number]
export type WfSign = WfInstanceDetailVo['signs'][number]

/** POST /wf/tasks/:id/<path> (cancel: POST /wf/instances/:id/cancel) */
const PATHS: Record<WfDecision, string> = {
  approve: 'approve',
  reject: 'reject',
  sendBack: 'send-back',
  transfer: 'transfer',
  delegate: 'delegate',
  addSign: 'add-sign',
  cc: 'cc',
  comment: 'comment',
  removeSign: 'remove-sign',
  withdraw: 'withdraw',
  resubmit: 'resubmit',
  cancel: 'cancel',
}

/** On my review task; a delegated or add-sign (child) one only approves, copies and comments. */
const TASK_ACTIONS: readonly WfDecision[] = [
  'approve',
  'reject',
  'sendBack',
  'transfer',
  'delegate',
  'addSign',
  'cc',
  'comment',
]
const CHILD_ACTIONS: readonly WfDecision[] = ['approve', 'cc', 'comment']

/** An action the caller may take, on a task (cancel, urge: the instance), and the step its sheet names. */
export interface WfOn {
  action: WfAction
  id: number
  /** a seeded model's is a key (`tx()`); '' = the instance */
  node: string
  /** the step takes no approval without a comment */
  commentRequired: boolean
}

/** My add-signs still pending, of one task of mine (a remove-sign takes one task's). */
export const mySigns = (inst: Pick<WfInstanceDetailVo, 'signs'>): WfSign[] =>
  inst.signs.filter((s) => s.parentTaskId === inst.signs[0]!.parentTaskId)

/**
 * What the caller may do on the instance, in this order: the actions of their oldest pending review task (a
 * reload after one offers the next), remove-sign, withdraw, and the initiator's urge, resubmit (sent back to
 * them: their `begin` task) and cancel.
 */
export function detailActions(
  inst: Pick<
    WfInstanceDetailVo,
    'id' | 'myTasks' | 'signs' | 'withdrawable' | 'canCancel' | 'canUrge'
  >,
): WfOn[] {
  const on = (action: WfAction, id: number, node = '', commentRequired = false) => ({
    action,
    id,
    node,
    commentRequired,
  })
  const task = inst.myTasks.find((x) => x.type === 'review')
  const out = task
    ? (task.child ? CHILD_ACTIONS : TASK_ACTIONS).map((a) =>
        on(a, task.id, task.nodeName, task.commentRequired),
      )
    : []
  const sign = inst.signs[0]
  if (sign) out.push(on('removeSign', sign.parentTaskId, sign.nodeName))
  const approval = inst.withdrawable
  if (approval) out.push(on('withdraw', approval.id, approval.nodeName))
  if (inst.canUrge) out.push(on('urge', inst.id))
  const begin = inst.myTasks.find((x) => x.type === 'begin')
  if (begin) out.push(on('resubmit', begin.id, begin.nodeName))
  if (inst.canCancel) out.push(on('cancel', inst.id))
  return out
}

/** What the decision sheet collects. */
export interface DecideForm {
  /** the comment; cc's note (its `reason`) */
  comment: string
  /** send back's step */
  to: string
  /** transfer and delegate: the first; add-sign and cc: all */
  user: PickedUser[]
  /** add-sign's */
  kind: WfSignKind
  /** remove-sign's */
  taskIds: number[]
}

const SCHEMAS: Record<WfDecision, ObjectSchema> = {
  approve: wfCommentBody,
  reject: wfCommentBody,
  sendBack: wfSendBackBody,
  transfer: wfHandOverBody,
  delegate: wfHandOverBody,
  addSign: wfAddSignBody,
  cc: wfCcBody,
  comment: wfRemarkBody,
  removeSign: wfRemoveSignBody,
  withdraw: wfCommentBody,
  resubmit: wfCommentBody,
  cancel: wfCommentBody,
}
/** The shared body schema of `action`. */
export const decideSchema = (action: WfDecision) => SCHEMAS[action]

/** Approving on a `commentRequired` step takes a comment: approve, reject and add-sign after. */
export const mustComment = (action: WfDecision, kind: WfSignKind, commentRequired: boolean) =>
  commentRequired &&
  (action === 'approve' || action === 'reject' || (action === 'addSign' && kind === 'after'))

/** cc's note is its `reason` */
export const noteField = (action: WfDecision) => (action === 'cc' ? 'reason' : 'comment')

/**
 * The sheet's input checked by `action`'s shared schema, and by wfRemarkBody's rule when it must carry a
 * comment (the server refuses it without one too): the body to post (other actions' fields left out), else
 * the issues to show.
 */
export function decideBody(
  action: WfDecision,
  form: DecideForm,
  commentRequired: boolean,
): { body?: object; issues: ValidationIssue[] } {
  const note = form.comment.trim() || undefined
  const input = {
    comment: note,
    reason: note,
    to: form.to || undefined,
    userId: form.user[0]?.id,
    userIds: form.user.map((u) => u.id),
    kind: form.kind,
    taskIds: form.taskIds,
  }
  const parsed = SCHEMAS[action].safeParse(input)
  const issues: ValidationIssue[] = [...(parsed.error?.issues ?? [])]
  if (mustComment(action, form.kind, commentRequired))
    issues.push(...(wfRemarkBody.safeParse(input).error?.issues ?? []))
  return issues.length ? { issues } : { body: parsed.data as object, issues }
}

/**
 * POSTs `action` on task `id` (cancel: on instance `id`). 404: no longer mine; 409: handled meanwhile (a
 * withdraw: the next step acted); 422: e.g. the user holds the step; 403: the model allows no withdraw/cancel.
 */
export const decide = (id: number, action: WfDecision, body: object) =>
  api.post<null>(
    action === 'cancel' ? `/wf/instances/${id}/cancel` : `/wf/tasks/${id}/${PATHS[action]}`,
    body,
  )

/** POST /wf/instances/:id/urge, silent: the page tells its 429 (once an hour) as "try later". */
export const urge = (id: number) =>
  api.post<null>(`/wf/instances/${id}/urge`, undefined, { silent: true })

/** GET /wf/tasks/:id/back-targets: steps already passed, newest first, then `begin` (the initiator). */
export const loadBackTargets = (taskId: number) =>
  api.get<WfBackTargetVo[]>(`/wf/tasks/${taskId}/back-targets`)

// ---- start (发起) -----------------------------------------------------------------------------------------

/** GET /wf/startable-models: the models the caller may start, in sort order. */
export const loadStartable = () => api.get<WfStartableVo[]>('/wf/startable-models')

/** The models by category (dict `wf.category`) in the dict's order, a category it lacks last. */
export function startGroups(models: WfStartableVo[], dict: DictPayload | undefined) {
  const choices = dictChoices(dict)
  const rank = (c: string) => choices.findIndex((x) => x.value === c) + 1 || choices.length + 1
  const by = new Map<string, WfStartableVo[]>()
  for (const m of models) by.set(m.category, [...(by.get(m.category) ?? []), m])
  return [...by]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([code, list]) => ({ code, label: choiceText(choices, code), models: list }))
}

/** A custom model's mobile create page (the registry maps its `create_route`); null = started on the desktop. */
export const createPage = (m: Pick<WfStartableVo, 'createRoute'>) =>
  MOBILE_FORMS.find((f) => f.createRoute === m.createRoute)?.form ?? null

/** GET /wf/models/:key/start-info: the steps whose users the initiator picks (a dynamic model's start). */
export const loadStartInfo = (modelKey: string) =>
  api.get<WfStartInfoVo>(`/wf/models/${encodeURIComponent(modelKey)}/start-info`)

export type Picked = Record<string, PickedUser[]>

/** Step id → its message, of the steps nobody was picked for yet (each needs somebody; the server's rule). */
export const picksMissing = (picks: WfStartInfoVo['picks'], picked: Picked) =>
  Object.fromEntries(
    picks
      .filter((p) => !picked[p.id]?.length)
      .map((p) => [p.id, t('validation.wf.picks_missing', { node: tx(p.name) })]),
  )

/**
 * POST /wf/instances: starts a dynamic model with the users picked per step and its form's values (a model
 * with a form; none: no `formValues` sent); the instance started.
 */
export const startModel = (modelKey: string, picked: Picked, formValues?: Record<string, unknown>) =>
  api.post<WfStartVo>('/wf/instances', {
    modelKey,
    initiatorPicks: Object.fromEntries(
      Object.entries(picked).map(([step, users]) => [step, users.map((u) => u.id)]),
    ),
    ...(formValues && { formValues }),
  })
