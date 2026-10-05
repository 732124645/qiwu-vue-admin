import type { OrgDirectory, WfAssignee, WfInstance } from '@qiwu/shared'

/** The instance data a resolution reads. */
export type WfAssigneeInstance = Pick<WfInstance, 'initiatorId' | 'formValues' | 'initiatorPicks'>

/** Positive integer ids in a stored value (one id or a list); anything else, e.g. a string, is no id. */
const idsIn = (value: unknown): number[] =>
  [value].flat().filter((v): v is number => Number.isSafeInteger(v) && (v as number) > 0)

/** `wanted` minus disabled / unknown users, in `wanted`'s order, each once. */
const enabledInOrder = async (org: OrgDirectory, wanted: number[]) => {
  const ok = new Set(await org.enabledUsers(wanted))
  return [...new Set(wanted)].filter((id) => ok.has(id))
}

/** Heads of each dept (`levels` up, nearest first), dept by dept, each once. */
const headsOf = async (org: OrgDirectory, deptIds: (number | null)[], levels: number) => [
  ...new Set(
    (
      await Promise.all(deptIds.flatMap((d) => (d === null ? [] : [org.deptHeads(d, levels)])))
    ).flat(),
  ),
]

/**
 * Who a review / notify node goes to (11 kinds; see docs/design-notes.md#workflow): enabled users only, each once; none = empty
 * (the caller applies `whenNobody`; `whenInitiatorIsReviewer` is the caller's too). Order is what `ordered`
 * signs follow: lists the designer or the initiator wrote (`users`, `deptHead` depts, `initiatorPicks`, a
 * form field) keep their order, role / position / dept lookups ascend by user id, head chains go nearest
 * first. `deptHeadChain` without `levels` goes up to the root.
 */
export async function resolveAssignees(
  node: { id: string; assignee: WfAssignee },
  inst: WfAssigneeInstance,
  org: OrgDirectory,
): Promise<number[]> {
  const { kind, ids = [], levels, field } = node.assignee
  const formValue = () => idsIn(field === undefined ? undefined : inst.formValues[field])
  switch (kind) {
    case 'users':
      return enabledInOrder(org, ids)
    case 'roles':
      return org.usersOfRoles(ids)
    case 'positions':
      return org.usersOfPositions(ids)
    case 'deptMembers':
      return org.usersOfDepts(ids)
    case 'deptHead':
      return headsOf(org, ids, 1)
    case 'deptHeadChain':
      return headsOf(org, [await org.deptOfUser(inst.initiatorId)], levels ?? Infinity)
    case 'initiator':
      return enabledInOrder(org, [inst.initiatorId])
    case 'initiatorPicks':
      return enabledInOrder(org, idsIn(inst.initiatorPicks[node.id]))
    case 'initiatorDeptHead':
      return headsOf(org, [await org.deptOfUser(inst.initiatorId)], 1)
    case 'formFieldUser':
      return enabledInOrder(org, formValue())
    case 'formFieldDeptHead':
      return headsOf(org, formValue(), 1)
  }
}
