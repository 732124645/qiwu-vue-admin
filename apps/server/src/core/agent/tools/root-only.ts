import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UseGuards,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { PLATFORM_ONLY, type PlatformOnlyWho } from '../../auth/platform-only.js'
import { clsGet } from '../../context/cls.js'

/**
 * 智能体平台设置里只有 root 能做的改动（模型与搜索服务商、外部 MCP 服务器与工具、工具策略、平台技能）：
 * 这些设置决定所有租户的出站目标与自动执行范围。`@PlatformOnly('root')` 只在多租户打开时检查 root，
 * 关闭时持有 `agent.setting.modify` 的任何人都能过，所以这里不看开关，对标了 `'root'` 的路由一律要求
 * root（403）。
 */
@Injectable()
export class AgentRootGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const who = this.reflector.getAllAndOverride<PlatformOnlyWho | undefined>(PLATFORM_ONLY, [
      ctx.getHandler(),
      ctx.getClass(),
    ])
    if (who === 'root' && clsGet('principal')?.root !== true) throw new ForbiddenException()
    return true
  }
}

/** 放在控制器类上：类里标了 `@PlatformOnly('root')` 的路由不论多租户开关都只有 root 能调用。 */
export const AgentRootOnly = () => UseGuards(AgentRootGuard)
