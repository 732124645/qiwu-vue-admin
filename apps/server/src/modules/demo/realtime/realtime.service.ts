import { ForbiddenException, Injectable } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  type DemoRealtimeSendBody,
  type DemoRealtimeSendVo,
  demoRealtimePerms,
  Err,
  RT,
} from '@qiwu/shared'
import { clsGet } from '../../../core/context/cls.js'
import { BaseCrudService } from '../../../core/db/base-crud.service.js'
import { BizError } from '../../../core/http/biz-error.js'
import { RealtimeService } from '../../../core/realtime/realtime.service.js'
import { User } from '../../platform/iam/user/user.entity.js'

/**
 * Realtime push demo: pushes the caller's plain text as a `demo:message` envelope through
 * RealtimeService. `user` / `role` targets reach only the enabled users of the caller's `iam_user`
 * scope for `demo.realtime.send` (root: everyone); a disabled role has no members; the rest are dropped
 * without an error. `all` needs
 * `demo.realtime.broadcast` and reaches every signed-in socket. The answer counts the distinct users
 * that had a live socket across the deployment when the message went out.
 */
@Injectable()
export class DemoRealtimeService extends BaseCrudService<User> {
  constructor(
    txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly realtime: RealtimeService,
  ) {
    super(txHost, User)
  }

  async send(body: DemoRealtimeSendBody): Promise<DemoRealtimeSendVo> {
    const p = clsGet('principal')
    if (!p) throw new BizError(Err.UNAUTHENTICATED)
    const all = body.target === 'all'
    if (all && !p.root && !p.perms.includes(demoRealtimePerms.broadcast))
      throw new ForbiddenException()
    const me = await this.repo.findOneByOrFail({ id: p.userId })
    const msg = {
      type: RT.demoMessage,
      payload: {
        from: { id: me.id, name: me.displayName },
        text: body.text,
        at: new Date().toISOString(),
      },
    }
    if (all) {
      const delivered = await this.realtime.onlineUsers()
      this.realtime.broadcast(msg)
      return { delivered }
    }
    const to = await this.recipients(body)
    const delivered = await this.realtime.onlineUsers(to)
    this.realtime.toUsers(to, msg)
    return { delivered }
  }

  /** Enabled users in the caller's scope among `userIds`, or holding one of the enabled `roleIds`. */
  private async recipients({ target, userIds, roleIds }: DemoRealtimeSendBody): Promise<number[]> {
    const qb = this.scopedQb('t').select('t.id', 'id').andWhere('t.enabled = 1')
    if (target === 'user') qb.andWhere('t.id IN (:...userIds)', { userIds })
    else
      qb.andWhere(
        `t.id IN (SELECT ur.user_id FROM iam_user_roles ur
                    JOIN iam_role r ON r.id = ur.role_id AND r.enabled = 1 AND r.deleted_at IS NULL
                   WHERE ur.role_id IN (:...roleIds) AND ur.deleted_at IS NULL)`,
        { roleIds },
      )
    return (await qb.getRawMany<{ id: number | string }>()).map((r) => Number(r.id))
  }
}
