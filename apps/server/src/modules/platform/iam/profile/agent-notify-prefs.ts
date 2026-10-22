import { Injectable } from '@nestjs/common'
import type { AgentNotifySettings } from '@qiwu/shared'
import type { AgentNotifyPrefs } from '../../../../core/agent/agent-ports.js'
import { ProfileService } from './profile.service.js'

/** 偏好键：不在 `table.*` 族里，个人中心的偏好接口读写不到它。 */
const KEY = 'agent.notify'

/** 智能体通知设置的存取端口：本人个人偏好里固定的一个键（读出的值由智能体一侧校验）。 */
@Injectable()
export class IamAgentNotifyPrefs implements AgentNotifyPrefs {
  constructor(private readonly profile: ProfileService) {}

  /** 本人存的通知设置，未设置为 null。 */
  getAgentNotify(userId: number): Promise<unknown> {
    return this.profile.getPref(userId, KEY)
  }

  /** 写入本人的通知设置（沿用偏好的大小与个数上限）。 */
  setAgentNotify(userId: number, value: AgentNotifySettings): Promise<void> {
    return this.profile.setPref(userId, KEY, value)
  }
}
