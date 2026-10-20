import { z } from 'zod'

/**
 * `APP_WXOA` (公众号模块开关) as the module list and the seeds read it, parsed like EnvSchema; unset or
 * invalid means off. Read at startup only (see docs/design-notes.md#wxoa).
 */
export const wxoaOn = (env: NodeJS.ProcessEnv = process.env): boolean =>
  z.stringbool().safeParse(env.APP_WXOA).data === true
