import { Err } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { clsGet } from '../../../../core/context/cls.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { SmsTemplate } from './sms-template.entity.js'

/**
 * The SMS sign-in / reset code path is root-managed: `auth.*` templates and every channel they
 * name. Whoever edits them could route codes through their own provider account and read them.
 */
export const isAuthTemplate = (code: string): boolean => code.toLowerCase().startsWith('auth.')

/** A non-root write to that path → 403 `grant_exceeds_own`. */
export const assertRootSmsWrite = (): void => {
  if (!clsGet('principal')?.root) throw new BizError(Err.IAM_GRANT_EXCEEDS_OWN)
}

/** Every auth.* template's route, matched in code: the column's collation must not decide what counts as auth.* */
export const authTemplates = async (manager: EntityManager) =>
  (
    await manager
      .getRepository(SmsTemplate)
      .find({ select: { code: true, channelId: true, providerTemplateId: true } })
  ).filter((row) => isAuthTemplate(row.code))
