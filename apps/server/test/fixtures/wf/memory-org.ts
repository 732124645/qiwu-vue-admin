import type { OrgDirectory } from '@qiwu/shared'

export interface MemUser {
  id: number
  dept?: number
  roles?: number[]
  positions?: number[]
  /** default true; false = disabled or deleted */
  enabled?: boolean
}
export interface MemDept {
  id: number
  parent?: number
  head?: number
}

/** `OrgDirectory` over plain lists for the engine specs; typeorm-org.ts is the TypeORM one, same contract. */
export function memoryOrg(users: MemUser[], depts: MemDept[] = []): OrgDirectory {
  const byId = new Map(users.map((u) => [u.id, u]))
  const deptOf = new Map(depts.map((d) => [d.id, d]))
  const enabled = (id: number | undefined) => id !== undefined && byId.get(id)?.enabled !== false
  const pick = (hit: (u: MemUser) => boolean) =>
    users
      .filter((u) => u.enabled !== false && hit(u))
      .map((u) => u.id)
      .sort((a, b) => a - b)
  /** `deptId` and its ancestors, nearest first */
  const upwards = (deptId: number) => {
    const chain: MemDept[] = []
    let d = deptOf.get(deptId)
    while (d) {
      chain.push(d)
      d = d.parent === undefined ? undefined : deptOf.get(d.parent)
    }
    return chain
  }
  const anyOf = (list: number[] | undefined, wanted: readonly number[]) =>
    list?.some((x) => wanted.includes(x)) ?? false

  return {
    enabledUsers: async (ids) => pick((u) => ids.includes(u.id)),
    usersOfRoles: async (ids) => pick((u) => anyOf(u.roles, ids)),
    usersOfPositions: async (ids) => pick((u) => anyOf(u.positions, ids)),
    usersOfDepts: async (ids) => pick((u) => u.dept !== undefined && ids.includes(u.dept)),
    deptOfUser: async (id) => byId.get(id)?.dept ?? null,
    deptHeads: async (deptId, levels) => [
      ...new Set(
        upwards(deptId)
          .slice(0, levels)
          .flatMap((d) => (enabled(d.head) ? [d.head!] : [])),
      ),
    ],
    initiatorCtx: async (id) => {
      const u = byId.get(id)
      const path = u?.dept === undefined ? [] : upwards(u.dept).map((d) => d.id)
      return {
        deptTreePath: path.length ? `/${path.reverse().join('/')}/` : null,
        roleIds: [...(u?.roles ?? [])].sort((a, b) => a - b),
      }
    },
  }
}
