import { type WfBeginNode, type WfFormSnapshot } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { ROOT_ROLE, TENANT_ADMIN_ROLE } from '../../../core/auth/principal.js'
import { DEFAULT_TENANT_ID, tenantId } from '../../../core/context/tenant.js'
import { findRow, insertRow } from '../upsert.js'

/** 新装流程由本租户管理员办理，避免让普通申请人任意指定自己或在无人时自动通过。 */
export async function officeSeedTree(q: EntityManager, source: WfBeginNode): Promise<WfBeginNode> {
  const code = tenantId() === DEFAULT_TENANT_ID ? ROOT_ROLE : TENANT_ADMIN_ROLE
  const role = await findRow(q, 'iam_role', { code, is_builtin: 1 })
  if (!role || role.deleted) throw new Error('office seed: the administrator role is missing')
  const tree = structuredClone(source)
  if (tree.next?.type !== 'review') throw new Error('office seed: a review node is required')
  tree.next.assignee = { kind: 'roles', ids: [role.id] }
  return tree
}

/** 仅为刚插入的模型发布首个快照；调用者已拒绝接管任何已有或已删除的模型。 */
export async function insertOfficeVersion(
  q: EntityManager,
  modelId: number,
  modelKey: string,
  tree: WfBeginNode,
  formSnapshot: WfFormSnapshot,
): Promise<void> {
  const versionId = await insertRow(q, 'wf_version', {
    model_id: modelId,
    model_key: modelKey,
    version: 1,
    tree_json: tree,
    form_snapshot: formSnapshot,
  })
  await q.query(
    'UPDATE wf_model SET current_version_id = ? WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [versionId, modelId, tenantId()],
  )
}
