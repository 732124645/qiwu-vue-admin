import { z } from 'zod'

/**
 * `APP_IM`（员工即时通讯开关），与 EnvSchema 同样解析；未设或非法都算关。只在启动时读（see docs/im.md）。
 */
export const imOn = (env: NodeJS.ProcessEnv = process.env): boolean =>
  z.stringbool().safeParse(env.APP_IM).data === true
