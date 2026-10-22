import { compile, type WfBeginNode } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { TRIP_FIELDS, TRIP_MODEL } from '../../../modules/oa/trip/trip-wf.handler.js'
import { findRow, insertRow } from '../upsert.js'
import { insertOfficeVersion, officeSeedTree } from './oa-process.seed.js'

/** 出差默认需要发起人选定审批人，人员不足时不得静默自动通过。 */
export const tripTree: WfBeginNode = {
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

/** 只为本租户首次安装发布默认流程，已有配置、停用和删除状态均由管理员保留。 */
export async function seedOaTrip(q: EntityManager): Promise<string[]> {
  if (await findRow(q, 'wf_model', { model_key: TRIP_MODEL })) return []
  const compiled = compile(await officeSeedTree(q, tripTree), TRIP_FIELDS)
  if (!compiled.ok) throw new Error('seedOaTrip: the trip process does not compile')
  const modelId = await insertRow(q, 'wf_model', {
    model_key: TRIP_MODEL,
    name: 'seed.oa.trip',
    description: 'seed.oa.tripDescription',
    category: 'other',
    icon: 'lucide:plane',
    form_kind: 'custom',
    create_route: '/oa/trip/new',
    view_component: 'oa/trip/view',
    draft_json: compiled.flow.root,
    enabled: 1,
    sort_no: 20,
  })
  await insertOfficeVersion(q, modelId, TRIP_MODEL, compiled.flow.root, { fields: TRIP_FIELDS })
  return []
}
