import type { OrgDirectory, WfInitiatorCtx } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'

/** A DataSource, or a transaction's EntityManager to read the org chart inside that transaction. */
export type OrgDb = Pick<EntityManager, 'query'>

const ids = (rows: { id: number | string }[]) => rows.map((r) => Number(r.id))

/**
 * `OrgDirectory` over iam_* (`memoryOrg` in test/fixtures/wf is the in-memory twin, same contract).
 * Users: enabled and not deleted. Roles and positions: a disabled or deleted one, or a deleted link row,
 * reaches nobody (as in auth, IamUserLookup). Depts: a deleted dept is no dept; a disabled
 * dept still exists in the org chart. `deptOfUser`/`initiatorCtx` also answer for a disabled or deleted user
 * (a running instance of a user deleted since still routes by their dept).
 */
export function typeormOrg(db: OrgDb): OrgDirectory {
  /** `sql` holds one `IN (?)` for `wanted`; nothing wanted = nothing found (MySQL rejects `IN ()`) */
  const usersIn = async (wanted: readonly number[], sql: string) =>
    wanted.length ? ids(await db.query<{ id: number }[]>(sql, [wanted])) : []

  const userDept = async (userId: number) =>
    (
      await db.query<{ id: number; tree_path: string }[]>(
        // qw:include-deleted u: a deleted user keeps their dept (see above); the dept must be live
        `SELECT d.id, d.tree_path FROM iam_user u
           JOIN iam_dept d ON d.id = u.dept_id AND d.deleted_at IS NULL
          WHERE u.id = ?`,
        [userId],
      )
    )[0]

  return {
    enabledUsers: (userIds) =>
      usersIn(
        userIds,
        'SELECT u.id FROM iam_user u WHERE u.id IN (?) AND u.enabled = 1 AND u.deleted_at IS NULL ORDER BY u.id',
      ),

    usersOfRoles: (roleIds) =>
      usersIn(
        roleIds,
        `SELECT DISTINCT u.id FROM iam_user_roles ur
           JOIN iam_role r ON r.id = ur.role_id AND r.enabled = 1 AND r.deleted_at IS NULL
           JOIN iam_user u ON u.id = ur.user_id AND u.enabled = 1 AND u.deleted_at IS NULL
          WHERE ur.role_id IN (?) AND ur.deleted_at IS NULL
          ORDER BY u.id`,
      ),

    usersOfPositions: (positionIds) =>
      usersIn(
        positionIds,
        `SELECT DISTINCT u.id FROM iam_user_positions up
           JOIN iam_position p ON p.id = up.position_id AND p.enabled = 1 AND p.deleted_at IS NULL
           JOIN iam_user u ON u.id = up.user_id AND u.enabled = 1 AND u.deleted_at IS NULL
          WHERE up.position_id IN (?) AND up.deleted_at IS NULL
          ORDER BY u.id`,
      ),

    usersOfDepts: (deptIds) =>
      usersIn(
        deptIds,
        `SELECT u.id FROM iam_user u
           JOIN iam_dept d ON d.id = u.dept_id AND d.deleted_at IS NULL
          WHERE u.dept_id IN (?) AND u.enabled = 1 AND u.deleted_at IS NULL
          ORDER BY u.id`,
      ),

    deptOfUser: async (userId) => {
      const dept = await userDept(userId)
      return dept ? Number(dept.id) : null
    },

    async deptHeads(deptId, levels) {
      const [dept] = await db.query<{ tree_path: string }[]>(
        'SELECT tree_path FROM iam_dept WHERE id = ? AND deleted_at IS NULL',
        [deptId],
      )
      // `/1/5/9/` holds the ancestors and the dept itself: nearest first, `levels` of them
      const chain = (dept?.tree_path.split('/').filter(Boolean).map(Number) ?? [])
        .reverse()
        .slice(0, levels)
      if (!chain.length) return []
      const rows = await db.query<{ id: number; head_user_id: number }[]>(
        `SELECT d.id, d.head_user_id FROM iam_dept d
           JOIN iam_user u ON u.id = d.head_user_id AND u.enabled = 1 AND u.deleted_at IS NULL
          WHERE d.id IN (?) AND d.deleted_at IS NULL`,
        [chain],
      )
      const headOf = new Map(rows.map((r) => [Number(r.id), Number(r.head_user_id)]))
      return [...new Set(chain.flatMap((id) => headOf.get(id) ?? []))]
    },

    async initiatorCtx(userId): Promise<WfInitiatorCtx> {
      const roles = await db.query<{ id: number }[]>(
        `SELECT r.id FROM iam_user_roles ur
           JOIN iam_role r ON r.id = ur.role_id AND r.enabled = 1 AND r.deleted_at IS NULL
          WHERE ur.user_id = ? AND ur.deleted_at IS NULL
          ORDER BY r.id`,
        [userId],
      )
      return { deptTreePath: (await userDept(userId))?.tree_path ?? null, roleIds: ids(roles) }
    },
  }
}
