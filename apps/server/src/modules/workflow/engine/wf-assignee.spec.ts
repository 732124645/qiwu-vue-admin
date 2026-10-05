import type { OrgDirectory, WfAssignee } from '@qiwu/shared'
import { describe, expect, it } from 'vitest'
import { memoryOrg } from '../../../../test/fixtures/wf/memory-org.js'
import { resolveAssignees, type WfAssigneeInstance } from './wf-assignee.js'

// depts: 1 ← 2 ← 3 ← 4, and 1 ← 5; user 2 heads 2 and 5, the head of 3 (user 9) is disabled, 4 has none
const mem = memoryOrg(
  [
    { id: 1, dept: 1, roles: [10] },
    { id: 2, dept: 2, roles: [10, 11], positions: [20] },
    { id: 3, dept: 3, roles: [11], positions: [20] },
    { id: 4, dept: 4, positions: [21] },
    { id: 5, dept: 4, roles: [10] },
    { id: 6 },
    { id: 9, dept: 3, roles: [10], positions: [20], enabled: false },
  ],
  [
    { id: 1, head: 1 },
    { id: 2, parent: 1, head: 2 },
    { id: 3, parent: 2, head: 9 },
    { id: 4, parent: 3 },
    { id: 5, parent: 1, head: 2 },
  ],
)
/** ids that reached the port: SQL would match '3' or true against id 3, so junk must stop before it */
const asked: unknown[] = []
const org: OrgDirectory = {
  ...mem,
  enabledUsers: async (ids) => (asked.push(...ids), mem.enabledUsers(ids)),
  deptHeads: async (deptId, levels) => (asked.push(deptId), mem.deptHeads(deptId, levels)),
}
const junk = [undefined, null, '3', 3.5, 0, -3, true, { id: 3 }, Number.NaN, 2 ** 53, [[3]]]

const inst = (extra: Partial<WfAssigneeInstance> = {}): WfAssigneeInstance => ({
  initiatorId: 4,
  formValues: {},
  initiatorPicks: {},
  ...extra,
})
const resolve = (assignee: WfAssignee, instance = inst(), nodeId = 'r') =>
  resolveAssignees({ id: nodeId, assignee }, instance, org)

describe('resolveAssignees', () => {
  it('users: the listed enabled users, in the designer order, each once', async () => {
    expect(await resolve({ kind: 'users', ids: [5, 3, 9, 404, 3] })).toEqual([5, 3])
    expect(await resolve({ kind: 'users', ids: [9] })).toEqual([])
  })

  it('roles / positions: enabled holders of any listed one, ascending', async () => {
    expect(await resolve({ kind: 'roles', ids: [11, 10] })).toEqual([1, 2, 3, 5])
    expect(await resolve({ kind: 'positions', ids: [20] })).toEqual([2, 3])
    expect(await resolve({ kind: 'positions', ids: [99] })).toEqual([])
  })

  it('deptMembers: enabled members of the listed depts, not of their sub-depts', async () => {
    expect(await resolve({ kind: 'deptMembers', ids: [4, 3] })).toEqual([3, 4, 5])
    expect(await resolve({ kind: 'deptMembers', ids: [2] })).toEqual([2])
  })

  it('deptHead: the enabled head of each listed dept, in list order, each once', async () => {
    expect(await resolve({ kind: 'deptHead', ids: [5, 2, 1] })).toEqual([2, 1])
    // a disabled head or no head adds nobody; the parent's head does not stand in
    expect(await resolve({ kind: 'deptHead', ids: [3, 4] })).toEqual([])
  })

  it('deptHeadChain: heads from the initiator dept upwards, nearest first, `levels` depts', async () => {
    // initiator 4 sits in dept 4 (no head) under 3 (disabled head) under 2 under 1
    expect(await resolve({ kind: 'deptHeadChain', levels: 2 })).toEqual([])
    expect(await resolve({ kind: 'deptHeadChain', levels: 3 })).toEqual([2])
    expect(await resolve({ kind: 'deptHeadChain', levels: 20 })).toEqual([2, 1])
    // no `levels` = up to the root
    expect(await resolve({ kind: 'deptHeadChain' })).toEqual([2, 1])
    expect(await resolve({ kind: 'deptHeadChain' }, inst({ initiatorId: 6 }))).toEqual([])
  })

  it('initiator: the initiator while enabled', async () => {
    expect(await resolve({ kind: 'initiator' })).toEqual([4])
    expect(await resolve({ kind: 'initiator' }, inst({ initiatorId: 9 }))).toEqual([])
  })

  it('initiatorPicks: the enabled users picked for this node, in pick order', async () => {
    const picks = inst({ initiatorPicks: { r: [5, 1, 9, 5], other: [3] } })
    expect(await resolve({ kind: 'initiatorPicks' }, picks)).toEqual([5, 1])
    expect(await resolve({ kind: 'initiatorPicks' }, picks, 'none')).toEqual([])
    // node ids are free text: inherited keys are no picks
    for (const id of ['constructor', '__proto__', 'toString'])
      expect(await resolve({ kind: 'initiatorPicks' }, inst(), id)).toEqual([])
    asked.length = 0
    const odd = { r: junk } as unknown as Record<string, number[]>
    expect(await resolve({ kind: 'initiatorPicks' }, inst({ initiatorPicks: odd }))).toEqual([])
    expect(asked).toEqual([])
  })

  it('initiatorDeptHead: the head of the initiator own dept only', async () => {
    expect(await resolve({ kind: 'initiatorDeptHead' }, inst({ initiatorId: 5 }))).toEqual([])
    expect(await resolve({ kind: 'initiatorDeptHead', levels: 3 })).toEqual([])
    expect(await resolve({ kind: 'initiatorDeptHead' }, inst({ initiatorId: 3 }))).toEqual([])
    expect(await resolve({ kind: 'initiatorDeptHead' }, inst({ initiatorId: 1 }))).toEqual([1])
    // heading one's own dept is left to whenInitiatorIsReviewer
    expect(await resolve({ kind: 'initiatorDeptHead' }, inst({ initiatorId: 2 }))).toEqual([2])
    expect(await resolve({ kind: 'initiatorDeptHead' }, inst({ initiatorId: 6 }))).toEqual([])
  })

  it('formFieldUser 解析', async () => {
    const byField = (approver: unknown) =>
      resolve({ kind: 'formFieldUser', field: 'approver' }, inst({ formValues: { approver } }))
    expect(await byField(3)).toEqual([3])
    expect(await byField([5, 3, 5, 9])).toEqual([5, 3])
    expect(await byField(9)).toEqual([])
    expect(await byField(404)).toEqual([])
    asked.length = 0
    for (const bad of junk) expect(await byField(bad)).toEqual([])
    expect(asked).toEqual([])
    // only the named field counts
    const other = inst({ formValues: { approver: 3, reviewer: 5 } })
    expect(await resolve({ kind: 'formFieldUser', field: 'reviewer' }, other)).toEqual([5])
    expect(await resolve({ kind: 'formFieldUser' }, other)).toEqual([])
  })

  it('formFieldDeptHead: the enabled head of the dept in the form field', async () => {
    const byField = (ownerDept: unknown) =>
      resolve(
        { kind: 'formFieldDeptHead', field: 'ownerDept' },
        inst({ formValues: { ownerDept } }),
      )
    expect(await byField(2)).toEqual([2])
    expect(await byField([1, 5, 2])).toEqual([1, 2])
    expect(await byField(4)).toEqual([])
    expect(await byField(3)).toEqual([])
    asked.length = 0
    for (const bad of junk) expect(await byField(bad)).toEqual([])
    expect(asked).toEqual([])
  })
})
