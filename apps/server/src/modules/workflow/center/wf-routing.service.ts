import { Injectable } from '@nestjs/common'
import {
  Err,
  type WfAddSignBody,
  type WfCcBody,
  type WfCommentBody,
  type WfHandOverBody,
  type WfRemarkBody,
  type WfRemoveSignBody,
} from '@qiwu/shared'
import { BizError } from '../../../core/http/biz-error.js'
import { reviewOf } from '../engine/actions.js'
import { emptyChangeSet, event } from '../engine/advance.js'
import { cancel, cc, comment, withdraw } from '../engine/lifecycle.js'
import { addSign, delegate, removeSign, transfer } from '../engine/routing.js'
import { WfModel } from '../model/wf-model.entity.js'
import { WfInstanceRow } from '../runtime/wf-runtime.entity.js'
import { type WfApplied, type WfRun, WfStore } from '../runtime/wf-store.js'
import { commentOf, WfDecideService } from './wf-decide.service.js'

const HOUR = 3_600_000

/** Instance actions are the initiator's (撤销实例、催办; see docs/design-notes.md#workflow): anybody else, an admin too, gets 404. */
function initiatedBy(run: WfRun, userId: number): void {
  if (run.inst.initiatorId !== userId) throw new BizError(Err.NOT_FOUND)
}

/** `wf_model.allow_cancel` / `allow_withdraw` of the instance's model (a deleted model allows neither). */
async function allows(run: WfRun, flag: 'allowCancel' | 'allowWithdraw'): Promise<boolean> {
  const model = await run.tx.getRepository(WfModel).findOneBy({ modelKey: run.inst.modelKey })
  return model?.[flag] === true
}

/**
 * Routing and lifecycle actions (转办/委派/加签/减签/抄送/撤回/评论/撤销实例/催办; see docs/design-notes.md#workflow),
 * sign-in only, over the engine. Task actions take the caller's task (`WfDecideService.act`: its
 * assignee, else 404; withdraw: the approved task's assignee, who approved it); a state the engine does not
 * expect is 409, a bad target 422. A model without `allow_withdraw` / `allow_cancel` refuses the action (403;
 * the initiator holding a sent-back `begin` task cancels anyway).
 */
@Injectable()
export class WfRoutingService {
  constructor(
    private readonly decide: WfDecideService,
    private readonly store: WfStore,
  ) {}

  /** 转办: the task is closed, `userId` gets a copy. */
  transfer(taskId: number, userId: number, body: WfHandOverBody): Promise<WfApplied> {
    return this.decide.act(taskId, userId, (run, task) =>
      transfer(run.ctx, run.inst, run.tasks, task, {
        to: body.userId,
        comment: body.comment || null,
      }),
    )
  }

  /** 委派: `userId` handles it first, then it is back with the caller to decide. */
  delegate(taskId: number, userId: number, body: WfHandOverBody): Promise<WfApplied> {
    return this.decide.act(taskId, userId, (run, task) =>
      delegate(run.ctx, run.inst, run.tasks, task, {
        to: body.userId,
        comment: body.comment || null,
      }),
    )
  }

  /**
   * 加签 before (the task waits for them) or after (the caller approves now, in effect once they have): an
   * after-sign is the caller's approval, so a `commentRequired` step wants its comment (else 422).
   */
  addSign(taskId: number, userId: number, body: WfAddSignBody): Promise<WfApplied> {
    return this.decide.act(taskId, userId, (run, task) => {
      const comment =
        body.kind === 'after'
          ? commentOf(reviewOf(run.ctx, task), body.comment)
          : body.comment || null
      return addSign(run.ctx, run.inst, run.tasks, task, { ...body, comment })
    })
  }

  /** 减签: cancels add-sign tasks of the caller's task still pending (another's, handled or unknown → 404). */
  removeSign(taskId: number, userId: number, body: WfRemoveSignBody): Promise<WfApplied> {
    return this.decide.act(taskId, userId, (run, task) =>
      removeSign(run.ctx, run.inst, run.tasks, task, { ...body, comment: body.comment || null }),
    )
  }

  /** 抄送 from the caller's pending task. */
  cc(taskId: number, userId: number, body: WfCcBody): Promise<WfApplied> {
    return this.decide.act(taskId, userId, (run, task) =>
      cc(run.ctx, run.inst, run.tasks, task, { ...body, reason: body.reason || null }),
    )
  }

  /** 评论 on the caller's pending task: an event only. */
  comment(taskId: number, userId: number, body: WfRemarkBody): Promise<WfApplied> {
    return this.decide.act(taskId, userId, (run, task) =>
      comment(run.ctx, run.inst, run.tasks, task, body),
    )
  }

  /**
   * 撤回 of the caller's approval, when the model allows it (else 403). The engine judges "the next tasks are
   * untouched" from every `wf_event` row of the instance (comments, delegations, add-signs, removed signs).
   */
  withdraw(taskId: number, userId: number, body: WfCommentBody): Promise<WfApplied> {
    return this.decide.act(taskId, userId, async (run, task) => {
      if (!(await allows(run, 'allowWithdraw'))) throw new BizError(Err.FORBIDDEN)
      const { events } = run
      return withdraw(run.ctx, run.inst, run.tasks, task, { comment: body.comment || null, events })
    })
  }

  /**
   * 撤销实例 by the initiator: when the model allows it, or anyway while they hold a pending `begin` task
   * (sent back to them: resubmit or cancel; see docs/design-notes.md#workflow); else 403. An ended instance is 409.
   */
  cancel(instanceId: number, userId: number, body: WfCommentBody): Promise<WfApplied> {
    return this.store.act(instanceId, async (run) => {
      initiatedBy(run, userId)
      const begin = run.ctx.flow.root.id
      const sentBack = run.tasks.some((t) => t.nodeId === begin && t.state === 'pending')
      if (!sentBack && !(await allows(run, 'allowCancel'))) throw new BizError(Err.FORBIDDEN)
      return cancel(run.ctx, run.inst, run.tasks, { comment: body.comment || null })
    })
  }

  /**
   * 催办 by the initiator: an `urge` event naming the holders of the instance's pending review tasks (none:
   * it ended or waits for the initiator, 409). Once an hour per instance by `urged_at`, else 429; the
   * instance lock orders concurrent urges.
   */
  urge(instanceId: number, userId: number): Promise<WfApplied> {
    return this.store.act(instanceId, async (run) => {
      const { inst, ctx } = run
      initiatedBy(run, userId)
      if (inst.urgedAt && ctx.now.getTime() - inst.urgedAt.getTime() < HOUR)
        throw new BizError(Err.TOO_MANY_REQUESTS)
      const holders = run.tasks
        .filter((t) => t.state === 'pending' && t.nodeId !== ctx.flow.root.id)
        .map((t) => t.assigneeId)
      if (!holders.length) throw new BizError(Err.CONFLICT)
      await run.tx.getRepository(WfInstanceRow).update(inst.id, { urgedAt: ctx.now })
      const set = emptyChangeSet()
      set.events.push(event('urge', null, userId, [...new Set(holders)]))
      return set
    })
  }
}
