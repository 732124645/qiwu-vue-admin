import { z } from 'zod'

/**
 * `APP_AGENT`（后台智能体开关）：模块列表在启动时读取，解析方式同 EnvSchema；未设置或无效即关闭
 * （see docs/agent.md）。
 */
export const agentOn = (env: NodeJS.ProcessEnv = process.env): boolean =>
  z.stringbool().safeParse(env.APP_AGENT).data === true
