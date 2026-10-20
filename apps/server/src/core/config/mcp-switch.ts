import { z } from 'zod'

/**
 * `APP_MCP`（智能体接入开关）：模块列表在启动时读取，解析方式同 EnvSchema；未设置或无效即关闭
 * （see docs/mcp.md）。
 */
export const mcpOn = (env: NodeJS.ProcessEnv = process.env): boolean =>
  z.stringbool().safeParse(env.APP_MCP).data === true
