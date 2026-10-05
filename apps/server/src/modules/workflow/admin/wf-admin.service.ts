import { Injectable } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  Err,
  type Page,
  type WfAdminInstanceQuery,
  type WfAdminInstanceVo,
  type WfAdminTaskQuery,
  type WfAdminTaskVo,
  type WfReassignBody,
  type WfTerminateBody,
} from '@qiwu/shared'
import type { EntityManager, ObjectLiteral, SelectQueryBuilder } from 'typeorm'
import {
  applyScopes,
  type DataScopeColumns,
  defaultScopeRules,
} from '../../../core/data-scope/data-scope.js'
import { paginate } from '../../../core/db/page.js'
import { BizError } from '../../../core/http/biz-error.js'
import { reassign, terminate } from '../engine/lifecycle.js'
import { WfInstanceRow, WfTaskRow } from '../runtime/wf-runtime.entity.js'
import { type WfApplied, type WfRun, WfStore } from '../runtime/wf-store.js'

/** The data scope of instances (admin pages): the initiator's dept, and the initiator for `own_rows`. */
export const WF_INSTANCE_SCOPE: DataScopeColumns = {
  dept: 'initiator_dept_id',
  owner: 'initiator_id',
}

/** `qb` limited to the instances (alias `i`) the caller's scope for the route's perm covers (root: all). */
export const scopedInstances = <Q extends SelectQueryBuilder<ObjectLiteral>>(qb: Q): Q =>
  applyScopes(qb, 'i', WF_INSTANCE_SCOPE, defaultScopeRules())

type WithInstance<T> = T & { instance: WfInstanceRow }

/**
 * Instance and task admin (管理员, 管理侧服务端; see docs/design-notes.md#workflow): lists, 终止 and 改派 behind `wfPerms`,
 * every one limited to the caller's data scope (for the route's perm) on `wf_instance.initiator_dept_id`;
 * an instance or task out of scope is 404, as an unknown one. The actions go through WfStore (instance
 * lock, conditional task updates, notifications) and the engine's `terminate` / `reassign`.
 */
@Injectable()
export class WfAdminService {
  constructor(
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly store: WfStore,
  ) {}

  /** GET /wf/instances */
  async instances(q: WfAdminInstanceQuery): Promise<Page<WfAdminInstanceVo>> {
    const qb = scopedInstances(this.txHost.tx.getRepository(WfInstanceRow).createQueryBuilder('i'))
    if (q.modelKey) qb.andWhere('i.modelKey = :modelKey', { modelKey: q.modelKey })
    if (q.state) qb.andWhere('i.state = :state', { state: q.state })
    if (q.initiatorId) qb.andWhere('i.initiatorId = :initiatorId', { initiatorId: q.initiatorId })
    const page = await paginate(qb, {
      ...q,
      sort: q.sort ?? [{ field: 'startedAt', order: 'DESC' }],
    })
    const view = await instanceView(this.txHost.tx, page.items)
    return { items: page.items.map(view.instance), total: page.total }
  }

  /** GET /wf/tasks */
  async tasks(q: WfAdminTaskQuery): Promise<Page<WfAdminTaskVo>> {
    const qb = scopedInstances(
      this.txHost.tx
        .getRepository(WfTaskRow)
        .createQueryBuilder('t')
        .innerJoinAndMapOne('t.instance', WfInstanceRow, 'i', 'i.id = t.instanceId'),
    )
    if (q.modelKey) qb.andWhere('i.modelKey = :modelKey', { modelKey: q.modelKey })
    if (q.state) qb.andWhere('t.state = :state', { state: q.state })
    if (q.assigneeId) qb.andWhere('t.assigneeId = :assigneeId', { assigneeId: q.assigneeId })
    if (q.instanceId) qb.andWhere('t.instanceId = :instanceId', { instanceId: q.instanceId })
    const page = await paginate(qb, {
      ...q,
      sort: q.sort ?? [{ field: 'createdAt', order: 'DESC' }],
    })
    const rows = page.items as WithInstance<WfTaskRow>[]
    const view = await instanceView(
      this.txHost.tx,
      rows.map((t) => t.instance),
      rows.map((t) => t.assigneeId),
    )
    return {
      items: rows.map((t) => {
        const { id, modelKey, modelName, initiator, dept, state } = view.instance(t.instance)
        return {
          id: t.id,
          nodeId: t.nodeId,
          nodeName: t.nodeName,
          assignee: view.user(t.assigneeId),
          ownerId: t.ownerId,
          state: t.state,
          createdAt: t.createdAt.toISOString(),
          handledAt: t.handledAt?.toISOString() ?? null,
          dueAt: t.dueAt?.toISOString() ?? null,
          instance: { id, modelKey, modelName, initiator, dept, state },
        }
      }),
      total: page.total,
    }
  }

  /** POST /wf/instances/:id/terminate: a running instance (else 409) ends `terminated`. */
  terminate(id: number, actorId: number, { comment }: WfTerminateBody): Promise<WfApplied> {
    return this.store.act(id, async (run) => {
      await this.assertInScope(run)
      return terminate(run.ctx, run.inst, run.tasks, { actorId, comment })
    })
  }

  /** POST /wf/tasks/:id/reassign: an open review task (else 409; a begin task 422) goes to `to`. */
  async reassign(taskId: number, actorId: number, { to, comment }: WfReassignBody) {
    const found = await this.txHost.tx.getRepository(WfTaskRow).findOneBy({ id: taskId })
    if (!found) throw new BizError(Err.NOT_FOUND)
    return this.store.act(found.instanceId, async (run) => {
      await this.assertInScope(run)
      const task = run.tasks.find((t) => t.id === taskId)
      if (!task) throw new BizError(Err.NOT_FOUND)
      return reassign(run.ctx, run.inst, run.tasks, task, { actorId, to, comment })
    })
  }

  /** The locked instance of `run` is in the caller's scope for the route's perm, else 404. */
  private async assertInScope({ tx, inst }: WfRun): Promise<void> {
    const qb = tx.getRepository(WfInstanceRow).createQueryBuilder('i')
    if (!(await scopedInstances(qb.where('i.id = :id', { id: inst.id })).getExists()))
      throw new BizError(Err.NOT_FOUND)
  }
}

/**
 * List items of `insts` with names, and user / dept refs of their initiators and depts, `users` and `depts`
 * (the data page's user / dept field values too).
 */
export async function instanceView(
  tx: EntityManager,
  insts: WfInstanceRow[],
  users: number[] = [],
  depts: number[] = [],
) {
  // ids are positive: `[0]` stands for none (`IN ()` is a syntax error)
  const ids = (list: (number | null)[]) => [0, ...new Set(list.filter((x) => x !== null))]
  const byId = async (rows: Promise<{ id: number; name: string }[]>) =>
    new Map((await rows).map((r) => [Number(r.id), r.name]))
  // a deleted user, dept or model keeps its name on the instances it took part in
  const userNames = await byId(
    tx.query(
      'SELECT id, display_name AS name FROM iam_user WHERE id IN (?)', // qw:include-deleted
      [ids([...insts.map((i) => i.initiatorId), ...users])],
    ),
  )
  const deptNames = await byId(
    tx.query(
      'SELECT id, name FROM iam_dept WHERE id IN (?)', // qw:include-deleted
      [ids([...insts.map((i) => i.initiatorDeptId), ...depts])],
    ),
  )
  const models = await byId(
    tx.query(
      // qw:include-deleted
      'SELECT v.id, m.name FROM wf_version v JOIN wf_model m ON m.id = v.model_id WHERE v.id IN (?)',
      [ids(insts.map((i) => i.versionId))],
    ),
  )
  const user = (id: number) => ({ id, name: userNames.get(id) ?? null })
  const dept = (id: number) => ({ id, name: deptNames.get(id) ?? null })
  const instance = (i: WfInstanceRow): WfAdminInstanceVo => ({
    id: i.id,
    modelKey: i.modelKey,
    modelName: models.get(i.versionId) ?? i.modelKey,
    initiator: user(i.initiatorId),
    dept: i.initiatorDeptId === null ? null : dept(i.initiatorDeptId),
    state: i.state,
    activeNodeIds: i.activeNodeIds,
    startedAt: i.startedAt.toISOString(),
    endedAt: i.endedAt?.toISOString() ?? null,
  })
  return { user, dept, instance }
}
