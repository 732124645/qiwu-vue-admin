// OAuth2 seed (see docs/design-notes.md#auth-sessions): the built-in `console` client (the admin web, read-only in the
// client pages) and the consent memory param. Its TTL columns keep their defaults and are never read:
// first-party sessions live by ACCESS_TTL_SEC / REFRESH_TTL_SEC. `mobile` is reserved by code, not by a row.
// The client pages seed their own menus.
import {
  type FirstPartyClient,
  type Locale,
  OAUTH_CONSENT_TTL_DAYS_DEFAULT,
  oauthParams,
} from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { upsert } from '../upsert.js'

const CONSENT_TTL_NAME = {
  'zh-CN': '记住授权天数（0 = 每次询问）',
  'en-US': 'Remember consent (days, 0 = always ask)',
} satisfies Record<Locale, string>

export async function seedOauth(q: EntityManager): Promise<string[]> {
  await upsert(
    q,
    'oauth_client',
    { client_id: 'console' satisfies FirstPartyClient },
    {
      name: 'seed.oauth.console',
      is_builtin: 1,
      grant_types: [],
      redirect_uris: [],
      scopes: [],
      auto_approve_scopes: [],
    },
  )
  await upsert(
    q,
    'cfg_param',
    { param_key: oauthParams.consentTtlDays },
    {
      name: CONSENT_TTL_NAME['zh-CN'],
      name_i18n: CONSENT_TTL_NAME,
      group_code: 'oauth',
      is_builtin: 1,
      is_public: 0,
    },
    { param_value: String(OAUTH_CONSENT_TTL_DAYS_DEFAULT) },
  )
  return []
}
