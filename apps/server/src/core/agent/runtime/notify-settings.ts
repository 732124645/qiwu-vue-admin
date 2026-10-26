import type { EntityManager } from 'typeorm'
import { Body, Controller, Get, Inject, Injectable, Logger, Optional, Put } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { type AgentNotifySettings, agentNotifySettings, agentPerms, Err } from '@qiwu/shared'
import { ActionLog } from '../../audit/action-log.js'
import { RequirePerm } from '../../auth/decorators.js'
import { HomeTenant } from '../../auth/tenant-scope.js'
import { clsGet } from '../../context/cls.js'
import { ApiEnvelope } from '../../http/api-envelope.decorator.js'
import { BizError } from '../../http/biz-error.js'
import { type NotifyChannelCode, Notifier } from '../../notify/notify.js'
import { redisKey } from '../../redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../redis/redis.module.js'
import { AGENT_NOTIFY_PREFS, type AgentNotifyPrefs } from '../agent-ports.js'
import type { AgentThread } from '../entities/agent-thread.entity.js'

/** 一轮的“等你”邮件只发一次的记号保留多久（远长于一轮通常等待的时间）。 */
const WAIT_MAIL_ONCE_MS = 7 * 24 * 3600_000

/** 默认只发站内信。 */
const DEFAULTS: AgentNotifySettings = {
  turnDone: { mail: false },
  waiting: { mail: false },
  automation: { mail: false },
}

export type AgentNoticeEvent = keyof AgentNotifySettings

/** 智能体的个人通知设置：站内信总是发，邮件按本人对每类提醒的开关；存在个人偏好里（iam 经端口提供）。 */
@Injectable()
export class AgentNotifySettingsService {
  private readonly logger = new Logger(AgentNotifySettingsService.name)

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Optional() @Inject(AGENT_NOTIFY_PREFS) private readonly prefs?: AgentNotifyPrefs,
  ) {}

  /** 本人的设置；没有偏好存储、没存过或存的值不合当前格式时用默认值。 */
  async get(userId: number): Promise<AgentNotifySettings> {
    if (!this.prefs) return DEFAULTS
    const parsed = agentNotifySettings.safeParse(await this.prefs.getAgentNotify(userId))
    return parsed.success ? parsed.data : DEFAULTS
  }

  /** 保存本人的设置并读回；没有偏好存储时 404（无处可存）。 */
  async save(userId: number, dto: AgentNotifySettings): Promise<AgentNotifySettings> {
    if (!this.prefs) throw new BizError(Err.NOT_FOUND)
    await this.prefs.setAgentNotify(userId, dto)
    return this.get(userId)
  }

  /**
   * 某类提醒发往哪些渠道：总是站内信（手机端经站内信同步），本人开了邮件再加邮件。给了 `turnId` 的
   * “等你”提醒，同一轮只发第一封邮件（一轮可能多次停下等确认或回答，站内信照发）。读设置出错时只发
   * 站内信：提醒不能因为偏好读不出来而丢掉。
   */
  async channels(
    userId: number,
    event: AgentNoticeEvent,
    turnId?: number,
  ): Promise<NotifyChannelCode[]> {
    try {
      if (!(await this.get(userId))[event].mail) return ['inbox']
    } catch (e) {
      this.logger.warn(
        { err: e instanceof Error ? e.name : 'Error' },
        'agent notify settings unread',
      )
      return ['inbox']
    }
    if (event === 'waiting' && turnId !== undefined && !(await this.firstMail(turnId)))
      return ['inbox']
    return ['inbox', 'mail']
  }

  /** 这一轮的“等你”邮件是否还没发过（占位成功即算发过）；Redis 出错时按已发处理：宁可少发，不重复发。 */
  private async firstMail(turnId: number): Promise<boolean> {
    try {
      const set = await this.redis.set(redisKey('agentWaitMail', turnId), '1', {
        condition: 'NX',
        expiration: { type: 'PX', value: WAIT_MAIL_ONCE_MS },
      })
      return set === 'OK'
    } catch (e) {
      this.logger.warn({ err: e instanceof Error ? e.name : 'Error' }, 'agent wait mail skipped')
      return false
    }
  }
}

/** 智能体给本人的提醒（一轮停下等你、耗时较长的一轮完成）。 */
@Injectable()
export class AgentNotices {
  private readonly logger = new Logger(AgentNotices.name)

  constructor(
    private readonly settings: AgentNotifySettingsService,
    private readonly notifier: Notifier,
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
  ) {}

  /**
   * 写下提醒记录（没有配置模板的渠道什么也不写）：总是站内信，本人对这类提醒开了邮件再写邮件（没有邮箱的
   * 只记一条跳过的邮件记录；“等你”邮件按 `turnId` 一轮一封）。放在事务里写，投递由事务提交后的异步流程
   * 完成（关闭时会等它）：轮次的推进不等 SMTP。参数只有会话编号（`title` 也是 `#编号`）。普通提醒失败
   * 只记日志；显式 manager 的风险提醒与调用方原生事务共同回滚，不发送幽灵通知。
   */
  async send(
    thread: AgentThread,
    template: string,
    event: AgentNoticeEvent,
    turnId?: number,
    manager?: EntityManager,
  ): Promise<void> {
    try {
      const userId = Number(thread.userId)
      const channels = await this.settings.channels(userId, event, turnId)
      const write = () =>
        this.notifier.send(
          {
            template,
            to: [userId],
            channels,
            // 不带会话标题与业务参数，只有本人的会话入口。
            params: { title: `#${thread.id}`, threadId: Number(thread.id) },
          },
          manager,
        )
      if (manager) await write()
      else await this.txHost.withTransaction(write)
    } catch (e) {
      // 风险标记与入口必须同成同败，不能吞掉出箱写入错误后留下无法找到的待核对会话。
      if (manager) throw e
      this.logger.warn({ err: e instanceof Error ? e.name : 'Error' }, 'agent notice skipped')
    }
  }
}

/** 已登录的调用者（这些路由都在 AuthGuard 之后）。 */
function me() {
  const p = clsGet('principal')
  if (!p) throw new BizError(Err.UNAUTHENTICATED)
  return p
}

/** 本人的智能体通知设置（`agent.chat.use`）。 */
@ApiTags('agent')
// 个人设置：进入其他租户的平台人员也在本人的租户里读写（不落进那个租户）
@HomeTenant()
@Controller('agent/notify-settings')
export class AgentNotifySettingsController {
  constructor(private readonly settings: AgentNotifySettingsService) {}

  @Get()
  @RequirePerm(agentPerms.chat.use)
  @ApiOperation({
    summary: "The caller's agent notification settings (the inbox always gets them)",
  })
  @ApiEnvelope(agentNotifySettings)
  mine() {
    return this.settings.get(me().userId)
  }

  @Put()
  @RequirePerm(agentPerms.chat.use)
  @ActionLog({ domain: 'agent.notify', verb: 'modify' })
  @ApiOperation({ summary: "Save the caller's agent notification settings (mail per notice kind)" })
  @ApiEnvelope(agentNotifySettings)
  save(@Body({ schema: agentNotifySettings }) dto: AgentNotifySettings) {
    return this.settings.save(me().userId, dto)
  }
}
