import { Injectable } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  Err,
  formUploadIds,
  formValuesSchema,
  type WfBackTargetVo,
  type WfChangeSet,
  type WfCommentBody,
  type WfDecideBody,
  type WfFieldAccess,
  type WfReviewNode,
  type WfSendBackBody,
  type WfTask,
} from '@qiwu/shared'
import { BizError } from '../../../core/http/biz-error.js'
import { ValidationException } from '../../../core/http/validation.pipe.js'
import { DictService } from '../../../core/settings/dict.service.js'
import { StorageService } from '../../platform/storage/storage.service.js'
import { approve, backTargets, reject, resubmit, reviewOf, sendBack } from '../engine/actions.js'
import { dictValuesOf, editableValues } from '../engine/form-values.js'
import { WfHandlers } from '../runtime/wf-handlers.js'
import { WfInstanceRow, WfTaskRow } from '../runtime/wf-runtime.entity.js'
import { type WfApplied, type WfRun, WfStore } from '../runtime/wf-store.js'

/** A task is acted on by its holder only (任务动作; see docs/design-notes.md#workflow): anybody else's, or none, is 404. */
function heldBy<T extends WfTask>(task: T | null | undefined, userId: number): T {
  if (task?.assigneeId !== userId) throw new BizError(Err.NOT_FOUND)
  return task
}

/**
 * `commentRequired` steps take no approval or rejection without a comment → 422; an after-sign is an
 * approval too (WfRoutingService.addSign).
 */
export function commentOf(node: WfReviewNode, comment: string | undefined): string | null {
  if (!comment && node.commentRequired) throw new BizError(Err.WF_COMMENT_REQUIRED)
  return comment || null
}

/**
 * Decisions on a task (通过/驳回/退回/重新提交; see docs/design-notes.md#workflow), sign-in only: the caller must hold it
 * (`assignee_id`; a delegated task is back with its owner as its assignee), else 404 — a `wf.task.manage`
 * admin too, who reassigns instead. A task no longer pending is 409 (the engine's patches expect `pending`).
 * Field access (`access`) holds for dynamic forms only: a custom form's values are its business row's.
 */
@Injectable()
export class WfDecideService {
  constructor(
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly handlers: WfHandlers,
    private readonly store: WfStore,
    private readonly storage: StorageService,
    private readonly dicts: DictService,
  ) {}

  /** GET back-targets: the steps a send-back of `taskId` may go to, newest first, then `begin`. */
  async backTargets(taskId: number, userId: number): Promise<WfBackTargetVo[]> {
    const { tx } = this.txHost
    const task = heldBy(await tx.getRepository(WfTaskRow).findOneBy({ id: taskId }), userId)
    const inst = await tx.getRepository(WfInstanceRow).findOneByOrFail({ id: task.instanceId })
    const ctx = await this.store.ctxOf(tx, inst.versionId, new Date())
    reviewOf(ctx, task, true)
    const tasks = await tx.getRepository(WfTaskRow).find({
      where: { instanceId: inst.id },
      order: { id: 'ASC' },
    })
    return backTargets(ctx, tasks, task).map((id) => {
      const { node } = ctx.flow.nodes.get(id)!
      return { id, name: node.name, type: node.type as WfBackTargetVo['type'] }
    })
  }

  /** 通过; a dynamic form's `formValues` keep the step's `edit` fields only. */
  approve(taskId: number, userId: number, body: WfDecideBody): Promise<WfApplied> {
    return this.act(taskId, userId, async (run, task) => {
      const node = reviewOf(run.ctx, task)
      const comment = commentOf(node, body.comment)
      const edits = await this.edits(run, userId, node.access, body.formValues)
      return approve(run.ctx, run.inst, run.tasks, task, { comment, edits })
    })
  }

  /** 驳回: the step's `onReject` ends the instance or sends it back to the last step passed. */
  reject(taskId: number, userId: number, body: WfCommentBody): Promise<WfApplied> {
    return this.act(taskId, userId, (run, task) => {
      const comment = commentOf(reviewOf(run.ctx, task), body.comment)
      return reject(run.ctx, run.inst, run.tasks, task, { comment })
    })
  }

  /** 退回 to one of the back targets (else 422); `begin` gives the initiator a task to resubmit. */
  sendBack(taskId: number, userId: number, body: WfSendBackBody): Promise<WfApplied> {
    return this.act(taskId, userId, (run, task) =>
      sendBack(run.ctx, run.inst, run.tasks, task, { to: body.to, comment: body.comment || null }),
    )
  }

  /**
   * 重新提交 of the initiator's `begin` task: a dynamic form's `formValues` keep the `begin.access` `edit`
   * fields; a custom form's values are read again from its business row (the initiator edited it there).
   */
  resubmit(taskId: number, userId: number, body: WfDecideBody): Promise<WfApplied> {
    return this.act(taskId, userId, async (run, task) => {
      const comment = body.comment || null
      const { businessKey, modelKey } = run.inst
      if (businessKey === null) {
        const edits = await this.edits(run, userId, run.ctx.flow.root.access, body.formValues)
        return resubmit(run.ctx, run.inst, run.tasks, task, { comment, edits })
      }
      const handler = this.handlers.get(modelKey)
      if (!handler) throw new BizError(Err.WF_HANDLER_MISSING, { modelKey })
      const formValues = await handler.loadFormValues(businessKey, run.tx)
      return resubmit(run.ctx, { ...run.inst, formValues }, run.tasks, task, { comment })
    })
  }

  /**
   * Locks the task's instance and runs `action` on the task, the caller's (else 404); the routing actions
   * (WfRoutingService) go through it too.
   */
  async act(
    taskId: number,
    userId: number,
    action: (run: WfRun, task: WfTask) => WfChangeSet | Promise<WfChangeSet>,
  ): Promise<WfApplied> {
    const row = await this.txHost.tx.getRepository(WfTaskRow).findOne({
      select: { id: true, instanceId: true },
      where: { id: taskId },
    })
    if (!row) throw new BizError(Err.NOT_FOUND)
    // the holder is checked on the locked rows: a concurrent transfer may have moved the task
    return this.store.act(row.instanceId, (run) =>
      action(
        run,
        heldBy(
          run.tasks.find((t) => t.id === taskId),
          userId,
        ),
      ),
    )
  }

  /**
   * A dynamic form's changes (`submitted`): its `access` `edit` fields, checked as on start
   * (`formValuesSchema`, 400 at `formValues.<field>`; the stored values were checked when sent); other fields
   * are dropped unchecked. Files a `qw-upload` field gained (ids its stored value does not name) are bound
   * to the instance in the action's transaction: the caller's own unbound uploads only, else 400 C1009
   *. A custom form (it has a business row) takes none.
   */
  private async edits(
    run: WfRun,
    userId: number,
    access: WfFieldAccess | undefined,
    submitted: Record<string, unknown> | undefined,
  ): Promise<Record<string, unknown> | undefined> {
    if (!submitted || run.inst.businessKey !== null) return undefined
    const { fields, schema } = run.ctx
    const changes = editableValues(submitted, access)
    const changed = Object.entries(fields).filter(([k]) => Object.hasOwn(changes, k))
    const rules = schema?.rule.filter((r) => Object.hasOwn(changes, r.field)) ?? []
    const dicts = await dictValuesOf(rules, (code) => this.dicts.entries(code))
    const r = formValuesSchema(Object.fromEntries(changed), schema, dicts).safeParse(changes)
    if (!r.success) {
      const e = new ValidationException(
        r.error.issues.map((i) => ({ ...i, path: ['formValues', ...i.path] })),
      )
      e.domain = 'wf.task'
      throw e
    }
    // per field: a file another field held (maybe one hidden from the caller) is new here
    const added = rules.flatMap((rule) => {
      const stored = new Set(formUploadIds([rule], run.inst.formValues))
      return formUploadIds([rule], r.data).filter((id) => !stored.has(id))
    })
    await this.storage.bindRefs(added, 'wf.attachment', `wf:${run.inst.id}`, userId, run.tx)
    return r.data
  }
}
