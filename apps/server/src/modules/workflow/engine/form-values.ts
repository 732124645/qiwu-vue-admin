import type {
  FormRule,
  OrgDirectory,
  WfCompiled,
  WfFieldAccess,
  WfNotifyNode,
  WfReviewNode,
} from '@qiwu/shared'
import { z } from 'zod'

// Start-time checks and field access (see docs/design-notes.md#workflow): what the start / resubmit / approve endpoints run
// before the engine moves a token. The values themselves: `formValuesSchema` (@qiwu/shared).

const id = z.number().int().positive()

/**
 * `formValuesSchema`'s `dicts` for `rules`: each dict a `qw-dict-select` rule names → the values of its
 * enabled entries (`entries`: DictService's read; an unknown or disabled dict → none).
 */
export async function dictValuesOf(
  rules: readonly FormRule[],
  entries: (code: string) => Promise<{ entries: { value: string }[] } | null>,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  for (const r of rules)
    if (r.type === 'qw-dict-select' && r.props?.code && !out.has(r.props.code))
      out.set(
        r.props.code,
        ((await entries(r.props.code))?.entries ?? []).map((e) => e.value),
      )
  return out
}

/** What a user whose node has `access` may see: every field but the `hide` ones (unlisted = `read`). */
export const visibleValues = (values: Record<string, unknown>, access: WfFieldAccess = {}) =>
  Object.fromEntries(Object.entries(values).filter(([k]) => access[k] !== 'hide'))

/**
 * What an approver (node `access`) or a resubmitting initiator (`begin.access`) may change: only the `edit`
 * fields of `submitted`, everything else is dropped. Parse the result with `formValuesSchema` (those fields
 * only: the stored values were checked when they were sent), then merge it over the stored values.
 */
export const editableValues = (submitted: Record<string, unknown>, access: WfFieldAccess = {}) =>
  Object.fromEntries(Object.entries(submitted).filter(([k]) => access[k] === 'edit'))

/**
 * A reader's field access on an instance (detail; see docs/design-notes.md#workflow): `hide` where any of `held` (the access of each step
 * they hold or held a task on, `begin` for the initiator) hides it, so an approver never reads it, not even
 * once their task is done; `edit` where `current` (the step of their pending task) allows it; unlisted =
 * `read`. No steps (a cc recipient, a `wf.instance.view` admin): every field `read`.
 */
export function readerAccess(
  held: readonly (WfFieldAccess | undefined)[],
  current?: WfFieldAccess,
): WfFieldAccess {
  const out: WfFieldAccess = {}
  for (const [k, v] of Object.entries(current ?? {})) if (v === 'edit') out[k] = v
  for (const a of held) for (const [k, v] of Object.entries(a ?? {})) if (v === 'hide') out[k] = v
  return out
}

type PickNode = WfReviewNode | WfNotifyNode

/** Nodes whose users the initiator picks when starting (`GET start-info` lists them). */
export const pickNodes = (flow: WfCompiled): PickNode[] =>
  [...flow.nodes.values()]
    .map((c) => c.node)
    .filter(
      (n): n is PickNode =>
        (n.type === 'review' || n.type === 'notify') && n.assignee.kind === 'initiatorPicks',
    )

export interface WfPicksError {
  nodeId: string
  /** `missing`: no user picked; `unknown_user`: `userIds` are not enabled users */
  code: 'missing' | 'unknown_user'
  userIds: unknown[]
}

export type WfPicksResult =
  { ok: true; picks: Record<string, number[]> } | { ok: false; errors: WfPicksError[] }

/**
 * `initiatorPicks` at start (400 on failure): every pick node needs a non-empty list of enabled users. On
 * success `picks` holds exactly the pick nodes' lists (the initiator's order, duplicates removed).
 */
export async function checkInitiatorPicks(
  flow: WfCompiled,
  picks: Readonly<Record<string, readonly unknown[]>> | null | undefined,
  org: Pick<OrgDirectory, 'enabledUsers'>,
): Promise<WfPicksResult> {
  const chosen = pickNodes(flow).map((n) => {
    const ids = picks?.[n.id]
    // inherited props (a node may be called `constructor`) and non-arrays count as no pick
    return [n.id, [...new Set(Array.isArray(ids) ? ids : [])]] as const
  })
  // only real ids reach the directory (a string '3' would match user 3 in SQL)
  const ask = [...new Set(chosen.flatMap(([, ids]) => ids))].filter(
    (v): v is number => id.safeParse(v).success,
  )
  const enabled = new Set<unknown>(ask.length ? await org.enabledUsers(ask) : [])
  const errors: WfPicksError[] = []
  for (const [nodeId, ids] of chosen) {
    const unknown = ids.filter((v) => !enabled.has(v))
    if (!ids.length) errors.push({ nodeId, code: 'missing', userIds: [] })
    else if (unknown.length) errors.push({ nodeId, code: 'unknown_user', userIds: unknown })
  }
  return errors.length
    ? { ok: false, errors }
    : { ok: true, picks: Object.fromEntries(chosen) as Record<string, number[]> }
}
