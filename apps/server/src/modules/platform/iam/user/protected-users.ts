import type { EntityManager } from 'typeorm'
import { type Principal, ROOT_ROLE, TENANT_ADMIN_ROLE } from '../../../../core/auth/principal.js'
import { tenantId } from '../../../../core/context/tenant.js'

/**
 * Why a user is protected (see docs/design-notes.md#tenancy), strongest first: `root` holds the builtin
 * root role, `owner` is its tenant's owner (`iam_tenant.owner_user_id`, the administrator made with the
 * tenant), `admin` holds the builtin `tenant_admin` role.
 */
export type Protection = 'root' | 'owner' | 'admin'

const RANK: Record<Protection, number> = { root: 3, owner: 2, admin: 1 }

/** The protected among the data tenant's users `ids`, each by its strongest reason. */
export async function protectedUsers(
  tx: EntityManager,
  ids: readonly number[],
): Promise<Map<number, Protection>> {
  const out = new Map<number, Protection>()
  if (!ids.length) return out
  const tid = tenantId()
  const put = (id: number, why: Protection) => {
    const had = out.get(id)
    if (!had || RANK[why] > RANK[had]) out.set(id, why)
  }
  const held = await tx.query<{ id: number; root: number }[]>(
    `SELECT DISTINCT ur.user_id AS id, (r.code = ?) AS root
       FROM iam_user_roles ur
       JOIN iam_role r ON r.id = ur.role_id AND r.tenant_id = ? AND r.is_builtin = 1
            AND r.code IN (?, ?) AND r.deleted_at IS NULL
      WHERE ur.user_id IN (?) AND ur.tenant_id = ? AND ur.deleted_at IS NULL`,
    [ROOT_ROLE, tid, ROOT_ROLE, TENANT_ADMIN_ROLE, ids, tid],
  )
  for (const r of held) put(Number(r.id), Number(r.root) === 1 ? 'root' : 'admin')
  const [tenant] = await tx.query<{ owner: number | null }[]>(
    'SELECT owner_user_id AS owner FROM iam_tenant WHERE id = ? AND deleted_at IS NULL',
    [tid],
  )
  const owner = tenant?.owner == null ? null : Number(tenant.owner)
  if (owner !== null && ids.includes(owner)) put(owner, 'owner')
  return out
}

/**
 * Whether caller `p` may write the password, contacts, dept or roles of a user protected by `why` (none:
 * anyone the routes let), or end its sessions: root every protected user; a `tenant_admin` holder the
 * other holders, never the owner nor a root user.
 */
export const mayManage = (p: Principal | undefined, why: Protection | undefined): boolean =>
  why === undefined || p?.root === true || (why === 'admin' && p?.tenantAdmin === true)

/**
 * Whether caller `p` may disable or delete a user protected by `why`: a root user and the owner never;
 * another `tenant_admin` holder root or a holder.
 */
export const mayRemove = (p: Principal | undefined, why: Protection | undefined): boolean =>
  why === undefined || (why === 'admin' && (p?.root === true || p?.tenantAdmin === true))
