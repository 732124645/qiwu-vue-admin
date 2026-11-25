import { compile, type WfBeginNode } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { SEAL_FIELDS, SEAL_MODEL } from '../../../modules/oa/seal/seal-wf.handler.js'
import { findRow, insertRow } from '../upsert.js'
import { insertOfficeVersion, officeSeedTree } from './oa-process.seed.js'

export const sealTree: WfBeginNode = {
  id: 'begin',
  type: 'begin',
  name: 'seed.wf.node.begin',
  next: {
    id: 'review',
    type: 'review',
    name: 'seed.oa.reviewer',
    assignee: { kind: 'initiatorPicks' },
    sign: 'any',
    whenNobody: 'toManager',
    whenInitiatorIsReviewer: 'self',
    onReject: 'finish',
  },
}

/** 仅为缺少的模型发布初始流程，保留已有流程与历史快照。 */
export async function seedOaSeal(q: EntityManager): Promise<string[]> {
  if (await findRow(q, 'wf_model', { model_key: SEAL_MODEL })) return []
  const compiled = compile(await officeSeedTree(q, sealTree), SEAL_FIELDS)
  if (!compiled.ok) throw new Error('seedOaSeal: the seal process does not compile')
  const modelId = await insertRow(q, 'wf_model', {
    model_key: SEAL_MODEL,
    name: 'seed.oa.seal',
    description: 'seed.oa.sealDescription',
    category: 'admin',
    icon: 'lucide:stamp',
    form_kind: 'custom',
    create_route: '/oa/seal/new',
    view_component: 'oa/seal/view',
    draft_json: compiled.flow.root,
    enabled: 1,
    sort_no: 40,
  })
  await insertOfficeVersion(q, modelId, SEAL_MODEL, compiled.flow.root, { fields: SEAL_FIELDS })
  return []
}
