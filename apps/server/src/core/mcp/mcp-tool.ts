import { SetMetadata } from '@nestjs/common'
import type { McpToolKind } from '@qiwu/shared'
import type { z } from 'zod'

export const MCP_TOOL = 'qw:mcp:tool'

/** A tool's longest time limit; the default is {@link MCP_TIMEOUT_MS}. */
export const MCP_TIMEOUT_MAX_MS = 120_000
export const MCP_TIMEOUT_MS = 30_000

/** What `@McpTool` declares about a provider method (see docs/mcp.md). */
export interface McpToolMeta {
  /** globally unique, `<domain>.<resource>.<verb>` (`iam.user.search`) */
  name: string
  /** a short human title */
  title: string
  /** what the agent reads to decide when to call it: what it does, what it returns */
  description: string
  /**
   * the permission the caller must hold (a code of the shared `*Perms` constants), or null for data any
   * signed-in user may read (the own profile, dict labels); never left out by accident: it is required
   */
  perm: string | null
  /** `write` tools change data: a token must allow them explicitly */
  kind: McpToolKind
  /** the arguments, validated before the method runs; also what the agent sees as the JSON Schema */
  input: z.ZodObject
  /** the answer's shape: the answer is parsed with it (unknown keys dropped) and sent as structured content */
  output?: z.ZodObject
  /** the time limit in ms (default 30 s, at most 120 s) */
  timeoutMs?: number
  /**
   * argument names whose values may be secrets under a plain name (`note`, `paramValue`): masked in the action
   * log at any depth, like `@Sensitive` on a route (secret-like names are masked anyway)
   */
  sensitive?: string[]
  /**
   * the top-level menu group (route name, e.g. `workflow`) whose feature the tool belongs to: a caller of a
   * tenant whose package lacks it cannot use the tool, like `@RequireFeature`. Mostly for `perm: null` tools,
   * which no tenant package narrows otherwise; a tool with a perm is narrowed by the package through the perm
   */
  feature?: string
}

/**
 * 把服务方法声明为 MCP 工具（see docs/mcp.md）：启动时扫描注册，名称全局唯一、权限点必须存在。
 * 方法收到已校验的参数，像控制器一样在调用者的租户、权限与数据权限下运行（CLS principal）；
 * 底座统一做令牌与权限检查、限流、超时、输出裁剪与操作日志，工具方法本身不必处理。
 */
export const McpTool = (meta: McpToolMeta): MethodDecorator => SetMetadata(MCP_TOOL, meta)
