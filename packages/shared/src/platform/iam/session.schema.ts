import { z } from 'zod'
import { PAGE_SIZE_MAX, pageQuery } from '../../common/pagination.js'
import { fieldDomains } from '../../validation/zod-i18n.js'

/**
 * Online sessions (iam/session), `/api/iam/sessions`: the live sessions of the
 * `auth:online` ZSET, each known by its `sid` (session id). Tokens are never listed: Redis holds only
 * their hashes. Field labels `field.iam.session.<prop>`.
 *
 * - `GET /` (`browse`): `sessionQuery` → `Page<sessionVo>`
 * - `DELETE /:sid` (`kick`): end one session (`sid` is a UUID; unknown or already ended → 404)
 * - `POST /kick` (`kick`): `sessionKickBody` = `{sids}` (batch) or `{userId}` (every session of the user)
 *   → `sessionKickVo`; ended / unknown sids are skipped
 *
 * A kick ends the session through SessionRevoker, pushes `session:kicked` to its sockets and disconnects
 * them, and writes a sign-in log row of kind `kicked`.
 */

export const sessionPerms = {
  browse: 'iam.session.browse',
  kick: 'iam.session.kick',
} as const

/** GET query: paging, sort and filters (`username`, `ip` contain; `clientId` equals). */
export const sessionQuery = pageQuery(['loginAt', 'lastSeenAt'])
  .extend({
    username: z.string().trim().max(64).optional(),
    ip: z.string().trim().max(64).optional(),
    clientId: z.string().trim().max(64).optional(),
  })
  .register(fieldDomains, { domain: 'iam.session' })
export type SessionQuery = z.output<typeof sessionQuery>

export const sessionVo = z.object({
  sid: z.uuid(),
  userId: z.number().int().nullable(),
  username: z.string().nullable(),
  /** i18n key (seeded depts) or plain text: render with `tx()` */
  deptName: z.string().nullable(),
  userType: z.string(),
  /** `console` for the admin UI, else an OAuth2 client */
  clientId: z.string(),
  ip: z.string(),
  /** from the IP (ip2region); null when unknown */
  location: z.string().nullable(),
  /** parsed from `userAgent` */
  browser: z.string().nullable(),
  os: z.string().nullable(),
  userAgent: z.string(),
  keepSignedIn: z.boolean(),
  loginAt: z.iso.datetime(),
  /** last authenticated request; null when unknown */
  lastSeenAt: z.iso.datetime().nullable(),
  /** when the session ends unless renewed (refresh expiry, capped by the absolute lifetime) */
  expiresAt: z.iso.datetime(),
  /** the caller's own session */
  current: z.boolean(),
})
export type SessionVo = z.infer<typeof sessionVo>

/** POST /kick body: exactly one of `sids` (1–200) or `userId`; both or neither → 400. */
export const sessionKickBody = z
  .object({
    sids: z.array(z.uuid()).min(1).max(PAGE_SIZE_MAX).optional(),
    userId: z.number().int().positive().optional(),
  })
  .refine((b) => (b.sids === undefined) !== (b.userId === undefined), {
    message: 'validation.invalid',
  })
  .register(fieldDomains, { domain: 'iam.session' })
export type SessionKickBody = z.infer<typeof sessionKickBody>

/** Kick result: how many sessions were ended. */
export const sessionKickVo = z.object({ kicked: z.number().int() })
export type SessionKickVo = z.infer<typeof sessionKickVo>
