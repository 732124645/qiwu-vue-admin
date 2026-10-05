import {
  bpmnPrecheck,
  isBpmnId,
  treeToXml,
  type WfBeginNode,
  type WfFields,
  type WfModelCreate,
  type WfModelDetailVo,
  type WfModelVo,
  type WfNode,
  type WfPublishBody,
  type WfVersionDetailVo,
  type WfVersionVo,
} from '@qiwu/shared'
import { tx } from '@/core/i18n'
import { viewLoader } from '@/core/router/build-routes'
import { idsOf, newId } from '../designer/tree'

type Grouped = { category: string }

/**
 * The rows grouped by category, groups in the dict's order (categories the dict lacks last, by code), each
 * group keeping the order it came in (the server's `sortNo`).
 */
export function byCategory<T extends Grouped>(rows: readonly T[], order: readonly string[]): T[] {
  const rank = (c: string) => order.indexOf(c) + 1 || order.length + 1
  return [...rows].sort(
    (a, b) => rank(a.category) - rank(b.category) || a.category.localeCompare(b.category),
  )
}

/** Rows the category cell of row `i` spans (el-table `span-method`): its group's size on the first row, else 0. */
export function categorySpan(rows: readonly Grouped[], i: number): number {
  const category = rows[i]?.category
  if (i > 0 && rows[i - 1]?.category === category) return 0
  let n = 1
  while (rows[i + n]?.category === category) n++
  return n
}

/**
 * The `PUT /sort` items once `row` moved one place up (-1) or down (1) inside its category (as `rows`
 * show it): the category renumbered 10, 20, …; null at the category's edge.
 */
export function moveInCategory<T extends Grouped & { id: number }>(
  rows: readonly T[],
  row: T,
  delta: -1 | 1,
): { id: number; sortNo: number }[] | null {
  const group = rows.filter((r) => r.category === row.category)
  // by id: el-table hands its slots reactive proxies of the rows
  const i = group.findIndex((r) => r.id === row.id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= group.length) return null
  ;[group[i], group[j]] = [group[j]!, group[i]!]
  return group.map((r, k) => ({ id: r.id, sortNo: (k + 1) * 10 }))
}

/** A loaded model as the form edits it: start scope lists and managers never null. */
export const toForm = (m: WfModelVo): WfModelVo => ({
  ...m,
  initiatorScope: m.initiatorScope ?? { userIds: [], deptIds: [], roleIds: [] },
  managerUserIds: m.managerUserIds ?? [],
})

/**
 * The form's body for POST and PUT: a custom model's page paths as typed (empty: not sent, a PUT cannot
 * clear them), a dynamic model's never (the server stores none); a dynamic model's form (null unbinds it),
 * a custom model's none; the managers only with `managers` (`wfPerms.model.managers`). The server drops
 * `modelKey` / `formKind` from a PUT; an empty start scope is stored as "everyone".
 */
export function toBody(m: WfModelCreate, managers = true): WfModelCreate {
  const custom = m.formKind === 'custom'
  return {
    ...m,
    formId: custom ? null : (m.formId ?? null),
    createRoute: (custom && m.createRoute) || undefined,
    viewComponent: (custom && m.viewComponent) || undefined,
    managerUserIds: managers ? m.managerUserIds : undefined,
  }
}

/** A custom model's view component exists among the web's views (the loader the instance detail uses). */
export const hasView = (component: string) => !!viewLoader(component.trim())

/**
 * The fields the designer builds on: the model's (its bound form's, a custom one's: its handler's); a dynamic
 * model without a form takes the ones its last version was published with (API or JSON).
 */
export const designFields = (m: WfModelDetailVo, versions: readonly WfVersionVo[]): WfFields =>
  m.fields ?? versions[0]?.formSnapshot.fields ?? {}

/** The saved draft, or a new flow of just its begin node (a draft is any object: checked on publish). */
export const draftTree = (draft: WfModelDetailVo['draftJson'], beginName: string): WfBeginNode =>
  draft?.type === 'begin' && typeof draft.id === 'string'
    ? (draft as unknown as WfBeginNode)
    : { id: 'begin', type: 'begin', name: beginName }

/**
 * A BPMN model's saved draft, or the XML of a new flow of just its begin node (the tree
 * designer's start, seed keys as text).
 */
export const draftXml = (m: WfModelDetailVo, beginName: string): string =>
  m.draftXml ?? treeToXml(draftTree(null, beginName), { nameOf: tx })

/** Express's JSON request body limit (100 KB, kept) */
const BODY_MAX = 100 * 1024

/**
 * Why the server would refuse a BPMN draft / publish `body` carrying `xml` before reading the diagram: over 80 KiB of XML or a DOCTYPE (`bpmnPrecheck`), or a JSON body over the request limit (the
 * same message instead of a 413). null = it can go.
 */
export const bpmnRefusal = (xml: string, body: object = { xml }) =>
  bpmnPrecheck(xml) ??
  (new TextEncoder().encode(JSON.stringify(body)).length > BODY_MAX ? 'bpmn_too_large' : null)

/**
 * The flow (a tree model's `tree`, a BPMN model's `xml`) and, for a dynamic model, its fields: they go into
 * the version's snapshot; a custom model's are its handler's (server).
 */
export const publishBody = (
  m: Pick<WfModelVo, 'formKind'>,
  flow: { tree: unknown } | { xml: string },
  fields: WfFields,
): WfPublishBody => (m.formKind === 'custom' ? flow : { ...flow, fields })

/** A version's JSON export: its tree and the fields it was published with, as `importBody` reads it. */
export const exportJson = (modelKey: string, v: WfVersionDetailVo): string =>
  JSON.stringify(
    { modelKey, version: v.version, tree: v.tree, fields: v.formSnapshot.fields },
    null,
    2,
  )

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * A JSON export (any `{ tree, fields? }`) as the publish body of model `m`: the server checks it like a
 * designed tree (`compile`). null = not such a JSON.
 */
export function importBody(m: Pick<WfModelVo, 'formKind'>, text: string): WfPublishBody | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(data) || !isObject(data.tree)) return null
  return publishBody(m, { tree: data.tree }, data.fields as WfFields)
}

/**
 * A version's JSON export (any `{ tree }` with a begin node) as the diagram a BPMN model's designer imports: node and path ids a diagram refuses (rule ⑦: a digit or `-` first, `__` first, a prototype name)
 * get new ones first (a draft has no instances yet), seed keys become text in the app language (`tx`: bpmn-js
 * draws names as they are). `renamed`: [old, new] per id. null = not such a JSON.
 */
export function jsonXml(text: string): { xml: string; renamed: [string, string][] } | null {
  try {
    const { tree } = JSON.parse(text) as { tree?: WfBeginNode }
    if (!isObject(tree) || tree.type !== 'begin') return null
    const taken = idsOf(tree)
    const renamed: [string, string][] = []
    const renew = (o: { id: string }, prefix: string) => {
      if (isBpmnId(o.id)) return
      const id = newId(prefix, taken)
      renamed.push([String(o.id), id])
      o.id = id
    }
    for (const stack: WfNode[] = [tree]; stack.length;) {
      const n = stack.pop()!
      renew(n, n.type)
      if (n.next) stack.push(n.next)
      if (n.type === 'fork')
        for (const p of n.paths) {
          renew(p, 'path')
          if (p.child) stack.push(p.child)
        }
    }
    return { xml: treeToXml(tree, { nameOf: tx }), renamed }
  } catch {
    // a tree of the wrong shape
    return null
  }
}
