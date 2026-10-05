import { Injectable } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  type DeptTreeNode,
  Err,
  type Page,
  PAGE_SIZE_MAX,
  type WfCcItemVo,
  type WfCcQuery,
  type WfDoneQuery,
  type WfInstanceItemVo,
  type WfMineQuery,
  type WfTaskItemVo,
  type WfTodoQuery,
  type WfUserOption,
  type WfUserOptionQuery,
} from '@qiwu/shared'
import { IsNull } from 'typeorm'
import { forest } from '../../../core/db/base-tree.service.js'
import { contains, paginate } from '../../../core/db/page.js'
import { BizError } from '../../../core/http/biz-error.js'
import { timeoutKey } from '../engine/timeout.js'
import { WfCcRow, WfInstanceRow, WfTaskRow } from '../runtime/wf-runtime.entity.js'
import { WfDetailService } from './wf-detail.service.js'

type WithInstance<T> = T & { instance: WfInstanceRow }

/** the remind job handled the task for its assignee: not theirs to list as done */
const SYSTEM_HANDLED = (['autoPass', 'autoReject', 'toManager', 'toAdmin'] as const).map(timeoutKey)

/**
 * The approval center lists (access model; see docs/design-notes.md#workflow): sign-in only, each one the caller's
 * own rows (`initiator_id` / `assignee_id` / `user_id` = the caller) on live instances. Todo = `pending`
 * tasks; done = the tasks the caller handled (`handled_at` set: approved, rejected, sent back, transferred),
 * so a task cancelled by someone else's action, or one delegated and still out, is in neither; nor one the
 * remind job approved, rejected or transferred for them (after a `remindOnly` / `failed` record it is
 * still theirs to handle).
 */
@Injectable()
export class WfListService {
  constructor(
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly details: WfDetailService,
  ) {}

  /** GET /wf/instances/mine */
  async mine(me: number, q: WfMineQuery): Promise<Page<WfInstanceItemVo>> {
    const qb = this.txHost.tx
      .getRepository(WfInstanceRow)
      .createQueryBuilder('i')
      .where('i.initiatorId = :me', { me })
    if (q.state) qb.andWhere('i.state = :state', { state: q.state })
    const page = await paginate(qb, {
      ...q,
      sort: q.sort ?? [{ field: 'startedAt', order: 'DESC' }],
    })
    const view = await this.view(page.items)
    return { items: page.items.map(view.instance), total: page.total }
  }

  /** GET /wf/tasks/todo */
  todo(me: number, q: WfTodoQuery): Promise<Page<WfTaskItemVo>> {
    return this.tasks(me, "t.state = 'pending'", {
      ...q,
      sort: q.sort ?? [{ field: 'createdAt', order: 'DESC' }],
    })
  }

  /** GET /wf/tasks/done */
  done(me: number, q: WfDoneQuery): Promise<Page<WfTaskItemVo>> {
    // idx_wf_event_instance
    const which = `t.handledAt IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM wf_event e
       WHERE e.instance_id = t.instanceId AND e.task_id = t.id AND e.action = 'timeout'
         AND e.comment IN (:...handled) AND e.deleted_at IS NULL)`
    return this.tasks(
      me,
      which,
      { ...q, sort: q.sort ?? [{ field: 'handledAt', order: 'DESC' }] },
      { handled: SYSTEM_HANDLED },
    )
  }

  /**
   * GET /wf/users/options: whom a process dialog picks, every enabled live user (OrgDirectory.enabledUsers'
   * rule; the org chart, not the caller's data scope), by display name.
   */
  async userOptions({ keyword }: WfUserOptionQuery): Promise<WfUserOption[]> {
    const rows = await this.txHost.tx.query<
      { id: number; display_name: string; dept_name: string | null }[]
    >(
      `SELECT u.id, u.display_name, d.name AS dept_name FROM iam_user u
         LEFT JOIN iam_dept d ON d.id = u.dept_id AND d.deleted_at IS NULL
        WHERE u.enabled = 1 AND u.deleted_at IS NULL AND u.display_name LIKE ?
        ORDER BY u.display_name, u.id LIMIT ?`,
      [contains(keyword ?? ''), PAGE_SIZE_MAX],
    )
    return rows.map((r) => ({
      id: Number(r.id),
      displayName: r.display_name,
      deptName: r.dept_name,
    }))
  }

  /**
   * GET /wf/depts/options: the depts a process form's dept field picks, every enabled live dept of
   * the org (not the caller's data scope, as `userOptions`), in GET /iam/depts/tree's shape: a forest by
   * `sort_no, id`, a dept whose parent is disabled a root.
   */
  async deptOptions(): Promise<DeptTreeNode[]> {
    const rows = await this.txHost.tx.query<{ id: number; parent_id: number; name: string }[]>(
      `SELECT id, parent_id, name FROM iam_dept
        WHERE enabled = 1 AND deleted_at IS NULL ORDER BY sort_no, id`,
    )
    return forest(
      rows.map((r) => ({ id: Number(r.id), parentId: Number(r.parent_id), name: r.name })),
    )
  }

  /** GET /wf/ccs/mine */
  async ccs(me: number, q: WfCcQuery): Promise<Page<WfCcItemVo>> {
    const qb = this.txHost.tx
      .getRepository(WfCcRow)
      .createQueryBuilder('c')
      .innerJoinAndMapOne('c.instance', WfInstanceRow, 'i', 'i.id = c.instanceId')
      .where('c.userId = :me', { me })
    if (q.unread !== undefined) qb.andWhere(q.unread ? 'c.readAt IS NULL' : 'c.readAt IS NOT NULL')
    const page = await paginate(qb, {
      ...q,
      sort: q.sort ?? [{ field: 'createdAt', order: 'DESC' }],
    })
    const rows = page.items as WithInstance<WfCcRow>[]
    const from = rows.flatMap((c) => (c.fromUserId === null ? [] : [c.fromUserId]))
    const view = await this.view(
      rows.map((c) => c.instance),
      from,
    )
    return {
      items: rows.map((c) => ({
        id: c.id,
        fromUser: c.fromUserId === null ? null : view.user(c.fromUserId),
        reason: c.reason,
        readAt: c.readAt?.toISOString() ?? null,
        createdAt: c.createdAt.toISOString(),
        instance: view.instance(c.instance),
      })),
      total: page.total,
    }
  }

  /** POST /wf/ccs/:id/read: only the caller's own copy (else 404); reading it again keeps the first time. */
  async read(me: number, id: number): Promise<void> {
    const repo = this.txHost.tx.getRepository(WfCcRow)
    const cc = await repo.findOneBy({ id, userId: me })
    if (!cc) throw new BizError(Err.NOT_FOUND)
    if (!cc.readAt) await repo.update({ id, readAt: IsNull() }, { readAt: new Date() })
  }

  private async tasks(
    me: number,
    which: string,
    q: WfTodoQuery | WfDoneQuery,
    params?: Record<string, unknown>,
  ): Promise<Page<WfTaskItemVo>> {
    const qb = this.txHost.tx
      .getRepository(WfTaskRow)
      .createQueryBuilder('t')
      .innerJoinAndMapOne('t.instance', WfInstanceRow, 'i', 'i.id = t.instanceId')
      .where('t.assigneeId = :me', { me })
      .andWhere(which, params)
    const page = await paginate(qb, q)
    const rows = page.items as WithInstance<WfTaskRow>[]
    const view = await this.view(rows.map((t) => t.instance))
    return {
      items: rows.map((t) => ({
        id: t.id,
        nodeId: t.nodeId,
        nodeName: t.nodeName,
        state: t.state,
        comment: t.comment,
        createdAt: t.createdAt.toISOString(),
        handledAt: t.handledAt?.toISOString() ?? null,
        instance: view.instance(t.instance),
      })),
      total: page.total,
    }
  }

  /** List items of `insts` (titles in the reader's language) and user refs of their initiators and `more`. */
  private async view(insts: WfInstanceRow[], more: number[] = []) {
    const models = await this.details.modelNames(insts.map((i) => i.versionId))
    const names = await this.details.userNames([...insts.map((i) => i.initiatorId), ...more])
    const title = await this.details.titler()
    const user = (id: number) => ({ id, name: names.get(id) ?? null })
    const instance = (i: WfInstanceRow): WfInstanceItemVo => {
      const modelName = models.get(i.versionId) ?? i.modelKey
      return {
        id: i.id,
        modelKey: i.modelKey,
        modelName,
        title: title(modelName, names.get(i.initiatorId) ?? null, i.startedAt),
        initiator: user(i.initiatorId),
        state: i.state,
        startedAt: i.startedAt.toISOString(),
        endedAt: i.endedAt?.toISOString() ?? null,
      }
    }
    return { user, instance }
  }
}
