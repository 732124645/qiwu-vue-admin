import { z } from 'zod'
import { fieldDomains } from '../../validation/zod-i18n.js'

/**
 * OAuth2 provider contract (see docs/design-notes.md#auth-sessions), `/api/oauth2`. Field labels `field.oauth.<prop>`.
 *
 * - `GET /authorize?<authorizeQuery>` (console session; the /sso page passes its query string as is) →
 *   `authorizeVo`; `pending` empty → the page approves at once. Every invalid request (unknown, disabled or
 *   first-party client, unregistered `redirect_uri`, no or `plain` PKCE, scope outside the client's,
 *   `response_type` ≠ `code`) is a 4xx envelope shown on the page: never a redirect to an unverified URI.
 * - `POST /authorize?<authorizeQuery>` `authorizeBody` → `authorizeRedirectVo` (code + state, or
 *   `error=access_denied`), followed by the page with `location.assign`.
 * - `POST /token`, `/introspect`, `/revoke`: RFC 6749/7662/7009 form bodies and raw RFC JSON answers; v1
 *   serves confidential clients only (secret required, with PKCE too).
 * - `GET /userinfo` (`@OAuthScope(user.read)`, user-delegated tokens only) → `userinfoVo`.
 */

/** Grant types a client may register (`password` and `implicit` are never served). */
export const OAUTH_GRANT_TYPES = [
  'authorization_code',
  'refresh_token',
  'client_credentials',
] as const
export type OAuthGrantType = (typeof OAUTH_GRANT_TYPES)[number]

export const OAUTH_SCOPE_USER_READ = 'user.read'
/** Scopes a client may register; v1 has only userinfo's. */
export const OAUTH_SCOPES = [OAUTH_SCOPE_USER_READ] as const

export const oauthParams = {
  /** days a consent is remembered; 0 = ask every time */
  consentTtlDays: 'oauth.consent_ttl_days',
} as const
export const OAUTH_CONSENT_TTL_DAYS_DEFAULT = 30

/**
 * The authorization request (RFC 6749 §4.1.1 + RFC 7636), as the query string of GET and POST /authorize.
 * PKCE is required and only `S256` (an omitted method means `plain`, RFC 7636 §4.3): a challenge is
 * base64url(sha256), exactly 43 characters. `scope` is space-separated, absent = the client's scopes;
 * `state` is echoed when present. The server checks `response_type` and the client.
 */
export const authorizeQuery = z
  .object({
    response_type: z.string().max(32),
    client_id: z.string().regex(/^[\w.-]{1,64}$/),
    redirect_uri: z.string().min(1).max(512),
    scope: z.string().max(512).optional(),
    state: z.string().max(512).optional(),
    code_challenge: z.string().regex(/^[\w-]{43}$/),
    code_challenge_method: z.literal('S256'),
  })
  .register(fieldDomains, { domain: 'oauth' })
export type AuthorizeQuery = z.output<typeof authorizeQuery>

/** POST /authorize: the user's answer; approving covers every requested scope. */
export const authorizeBody = z
  .object({ approve: z.boolean() })
  .register(fieldDomains, { domain: 'oauth' })
export type AuthorizeBody = z.output<typeof authorizeBody>

export const authorizeVo = z.object({
  /** `name` is a seed key or plain text: render it with `tx()` */
  client: z.object({ clientId: z.string(), name: z.string(), logoUrl: z.string().nullable() }),
  /** what the code will carry */
  scopes: z.array(z.string()),
  /** scopes still needing the user's consent; empty → approve at once */
  pending: z.array(z.string()),
})
export type AuthorizeVo = z.output<typeof authorizeVo>

/** The client's `redirect_uri` with `code` and `state`, or `error=access_denied` and `state`. */
export const authorizeRedirectVo = z.object({ redirectTo: z.string() })
export type AuthorizeRedirectVo = z.output<typeof authorizeRedirectVo>

/** `avatarUrl` may be a path on this site (`/files/…`). */
export const userinfoVo = z.object({
  sub: z.string(),
  username: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  locale: z.string().nullable(),
})
export type UserinfoVo = z.output<typeof userinfoVo>
