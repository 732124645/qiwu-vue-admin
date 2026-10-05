import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import OAuth2Server from '@node-oauth/oauth2-server'
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  type AuthorizeQuery,
  type AuthorizeRedirectVo,
  type AuthorizeVo,
  Err,
  OAUTH_CONSENT_TTL_DAYS_DEFAULT,
  OAUTH_GRANT_TYPES,
  type OAuthGrantType,
  oauthParams,
  type UserinfoVo,
} from '@qiwu/shared'
import type { Request, Response } from 'express'
import { z } from 'zod'
import { PermVersion } from '../../../../core/auth/perm-version.js'
import { SessionRevoker } from '../../../../core/auth/session-revoker.js'
import { isFirstParty, TokenService } from '../../../../core/auth/token.service.js'
import { USER_LOOKUP, type UserLookup } from '../../../../core/auth/user-lookup.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { ParamService } from '../../../../core/settings/param.service.js'
import { oauthModel } from './oauth-model.js'

/** A live (enabled, not deleted) third-party client as the provider reads it. */
export interface ClientRow {
  /** `oauth_client.id` */
  id: number
  clientId: string
  secretHash: string | null
  name: string
  logoUrl: string | null
  grants: OAuthGrantType[]
  redirectUris: string[]
  scopes: string[]
  autoApprove: string[]
  accessTtl: number
  refreshTtl: number
}

/** An authorization code lives 5 minutes and is used once. */
export const CODE_TTL_MS = 300_000

const field = z.string().max(2048).optional()
/**
 * RFC 6749 §4.1.3/§4.4/§6 token request (form body). Express parses forms with `qs`: an array or
 * object in any field is refused here, before the library sees it.
 */
export const tokenForm = z.object({
  grant_type: field.describe('authorization_code | refresh_token | client_credentials'),
  code: field,
  redirect_uri: field.describe('the one of the authorization request'),
  code_verifier: field.describe('PKCE verifier (S256)'),
  refresh_token: field,
  scope: field.describe('space-separated; client_credentials: default = the client’s scopes'),
  client_id: field.describe('or HTTP Basic'),
  client_secret: field.describe('or HTTP Basic; required (confidential clients only)'),
})
/** RFC 7662 introspection / RFC 7009 revocation request (form body). */
export const tokenAuthForm = z.object({
  token: z.string().min(1).max(2048).describe('an access or refresh token'),
  token_type_hint: field.describe('ignored'),
  client_id: field.describe('or HTTP Basic'),
  client_secret: field.describe('or HTTP Basic'),
})

/**
 * `oauth_client.secret_hash` of a secret: hex sha256. Secrets are 256 random server-made bits, so a fast
 * hash is enough; bcrypt would cost ~0.4 s of the event loop per /token, /introspect or /revoke call.
 */
export const secretDigest = (secret: string) => createHash('sha256').update(secret).digest('hex')
/** what an unknown or secretless client's secret is compared with (no digest matches it) */
const NO_DIGEST = Buffer.alloc(32)

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' }
const secs = (ms: number) => Math.floor(ms / 1000)
const invalidRequest = (res: Response) =>
  res.status(400).set(NO_STORE).json({ error: 'invalid_request' })

/** HTTP Basic client credentials, split at the first `:` (not form-decoded, like the library). */
function basic(header: string | undefined): { id: string; secret: string } | null {
  const m = /^Basic ([A-Za-z0-9+/]+=*)$/i.exec(header ?? '')
  if (!m) return null
  const pair = Buffer.from(m[1]!, 'base64').toString()
  const i = pair.indexOf(':')
  return i < 0 ? null : { id: pair.slice(0, i), secret: pair.slice(i + 1) }
}

/**
 * OAuth2 provider (see docs/design-notes.md#auth-sessions): clients from `oauth_client` (raw SQL: the client pages own
 * the entity), authorization codes, and the RFC endpoints `/token` (through `@node-oauth/oauth2-server`),
 * `/introspect` and `/revoke`. Third-party sessions are ordinary TokenService sessions with the client's
 * `client_id` and scopes: AuthGuard lets them reach only `@OAuthScope` routes; the online list, kicks
 * and every `revokeUser` (password change, disable…) cover them.
 */
@Injectable()
export class OAuthProvider {
  constructor(
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly tokens: TokenService,
    private readonly revoker: SessionRevoker,
    private readonly permVersion: PermVersion,
    private readonly params: ParamService,
    @Inject(USER_LOOKUP) private readonly lookup: UserLookup,
  ) {}

  /**
   * The enabled, live client `clientId`; never a first-party id (`console`, `mobile`): a session of a
   * row named so would pass AuthGuard as first-party, i.e. reach the whole admin API.
   */
  async client(clientId: string): Promise<ClientRow | null> {
    // a non-ASCII id would make MySQL fail on the ascii_bin column (500), not miss
    if (isFirstParty(clientId) || !/^[\w.-]{1,64}$/.test(clientId)) return null
    const [row] = await this.txHost.tx.query<ClientRow[]>(
      `SELECT id, client_id AS clientId, secret_hash AS secretHash, name, logo_url AS logoUrl,
        grant_types AS grants, redirect_uris AS redirectUris, scopes, auto_approve_scopes AS autoApprove,
        access_ttl_sec AS accessTtl, refresh_ttl_sec AS refreshTtl
       FROM oauth_client WHERE client_id = ? AND enabled = 1 AND deleted_at IS NULL`,
      [clientId],
    )
    return row ? { ...row, id: Number(row.id) } : null
  }

  /** Re-check the authenticated row after issuing: a reused client_id is a different client. */
  async clientEnabled(id: number): Promise<boolean> {
    const rows = await this.txHost.tx.query<{ id: number }[]>(
      'SELECT id FROM oauth_client WHERE id = ? AND enabled = 1 AND deleted_at IS NULL',
      [id],
    )
    return rows.length > 0
  }

  /**
   * The client when `secret` is its secret. Confidential clients only: no secret, no client
   * — with PKCE too (the library would let a PKCE request skip it). Unknown and secretless clients are
   * compared as well (constant time), so timing does not tell them apart.
   */
  async authenticate(clientId: string, secret: string | undefined): Promise<ClientRow | null> {
    if (!secret || secret.length > 128) return null
    const row = await this.client(clientId)
    const want = row?.secretHash ? Buffer.from(row.secretHash, 'hex') : NO_DIGEST
    const got = createHash('sha256').update(secret).digest()
    const ok = want.length === got.length && timingSafeEqual(want, got)
    return ok && row?.secretHash ? row : null
  }

  /** A new single-use authorization code of `userId` for client `c` (the consent page's approve). */
  async issueCode(
    userId: number,
    c: ClientRow,
    req: { redirectUri: string; scopes: string[]; challenge: string },
  ): Promise<string> {
    const code = randomBytes(32).toString('base64url')
    // read before the code exists: a revocation after this refuses the exchange (TokenService.issue)
    const credVer = await this.tokens.credVersion(userId)
    await this.tokens.saveCode(
      code,
      {
        client: c.clientId,
        clientPk: c.id,
        userId,
        redirectUri: req.redirectUri,
        scopes: req.scopes,
        challenge: req.challenge,
        credVer,
        exp: Date.now() + CODE_TTL_MS,
      },
      CODE_TTL_MS,
    )
    return code
  }

  /**
   * GET /authorize (the consent page): the client, the scopes a code would carry and those still
   * needing the user's consent (not auto-approved, no live consent; all of them when consents are
   * not remembered). Changes nothing.
   */
  async preview(userId: number, q: AuthorizeQuery): Promise<AuthorizeVo> {
    const { c, scopes } = await this.check(q)
    const granted = (await this.consentDays())
      ? (
          await this.txHost.tx.query<{ scope: string }[]>(
            `SELECT scope FROM oauth_consent WHERE user_id = ? AND client_id = ?
              AND expires_at > CURRENT_TIMESTAMP(3) AND deleted_at IS NULL`,
            [userId, c.id],
          )
        ).map((r) => r.scope)
      : []
    return {
      client: { clientId: c.clientId, name: c.name, logoUrl: c.logoUrl },
      scopes,
      pending: scopes.filter((s) => !c.autoApprove.includes(s) && !granted.includes(s)),
    }
  }

  /**
   * POST /authorize: the user's answer to a request `check` accepts, as the URL to send the browser
   * to — the registered `redirect_uri` (its own query kept) with `code`, or `error=access_denied`, and
   * `state`. Approving covers every requested scope and remembers them for `oauth.consent_ttl_days`.
   */
  async decide(userId: number, q: AuthorizeQuery, approve: boolean): Promise<AuthorizeRedirectVo> {
    const { c, scopes } = await this.check(q)
    const url = new URL(q.redirect_uri)
    if (approve) {
      await this.remember(userId, c, scopes)
      const code = await this.issueCode(userId, c, {
        redirectUri: q.redirect_uri,
        scopes,
        challenge: q.code_challenge,
      })
      url.searchParams.set('code', code)
    } else url.searchParams.set('error', 'access_denied')
    if (q.state !== undefined) url.searchParams.set('state', q.state)
    return { redirectTo: url.href }
  }

  /** GET /userinfo of a user-delegated token: the user's public profile, nothing more. */
  async userinfo(userId: number): Promise<UserinfoVo> {
    const u = await this.lookup.profile(userId)
    // AuthGuard reloaded the user just before: gone in between
    if (!u) throw new UnauthorizedException()
    return {
      sub: String(u.id),
      username: u.username,
      name: u.displayName,
      avatarUrl: u.avatarUrl,
      locale: u.locale,
    }
  }

  /**
   * An authorization request the provider serves (both /authorize): a live third-party client with the
   * authorization_code grant and `redirect_uri` registered verbatim (no normalisation, prefix or
   * wildcard: nothing is ever sent to an unverified URI) → else B4001; `response_type=code` and scopes
   * (space-separated; absent = the client's) within the client's → else B4002. PKCE S256 is zod's.
   */
  private async check(q: AuthorizeQuery): Promise<{ c: ClientRow; scopes: string[] }> {
    const c = await this.client(q.client_id)
    if (!c || !c.grants.includes('authorization_code') || !c.redirectUris.includes(q.redirect_uri))
      throw new BizError(Err.OAUTH_CLIENT_INVALID)
    if (q.response_type !== 'code') throw new BizError(Err.OAUTH_REQUEST_INVALID)
    const scopes =
      q.scope === undefined ? c.scopes : [...new Set(q.scope.split(' ').filter(Boolean))]
    if (!scopes.length || !scopes.every((s) => c.scopes.includes(s)))
      throw new BizError(Err.OAUTH_REQUEST_INVALID)
    return { c, scopes }
  }

  /** `oauth.consent_ttl_days`: how long an approval is remembered; 0 = ask every time. */
  private consentDays() {
    return this.params.int(oauthParams.consentTtlDays, 0, 3650, OAUTH_CONSENT_TTL_DAYS_DEFAULT)
  }

  /** Stores (or renews, or revives) the consent to the `scopes` not auto-approved. */
  private async remember(userId: number, c: ClientRow, scopes: string[]): Promise<void> {
    const days = await this.consentDays()
    const asked = scopes.filter((s) => !c.autoApprove.includes(s))
    if (!days || !asked.length) return
    const until = new Date(Date.now() + days * 86_400_000)
    await this.txHost.tx.query(
      `INSERT INTO oauth_consent (user_id, client_id, scope, expires_at) VALUES ? AS n
        ON DUPLICATE KEY UPDATE expires_at = n.expires_at, deleted_at = NULL`,
      [asked.map((s) => [userId, c.id, s, until])],
    )
  }

  /** RFC 6749 token endpoint: the library's raw RFC answer (`invalid_grant`, … as `{error}`). */
  async token(req: Request, res: Response, at: { ip: string; ua: string }): Promise<void> {
    const body = tokenForm.safeParse(req.body)
    if (!body.success) return void invalidRequest(res)
    const grant = body.data.grant_type
    // the library also serves `password` (it cannot be removed): refuse every other grant first
    if (grant !== undefined && !(OAUTH_GRANT_TYPES as readonly string[]).includes(grant))
      return void res.status(400).set(NO_STORE).json({ error: 'unsupported_grant_type' })
    const server = new OAuth2Server({
      model: oauthModel(
        {
          authenticate: (id, secret) => this.authenticate(id, secret),
          clientEnabled: (id) => this.clientEnabled(id),
          tokens: this.tokens,
          revoker: this.revoker,
          permVersion: this.permVersion,
        },
        at,
      ),
      // required, never used: saveToken answers with TokenService's tokens and lifetimes
      accessTokenLifetime: 1800,
      refreshTokenLifetime: 1800,
      allowExtendedTokenAttributes: true,
    })
    const r = new OAuth2Server.Response()
    try {
      await server.token(
        new OAuth2Server.Request({
          headers: req.headers as Record<string, string>,
          method: req.method,
          query: {},
          body: body.data,
        }),
        r,
      )
    } catch (e) {
      // a 5xx would carry the inner error's message: the global filter answers it (500, logged, masked)
      if (!(e instanceof OAuth2Server.OAuthError) || e.code >= 500)
        throw (e as { inner?: unknown }).inner ?? e
      // the method and content-type checks throw before the library writes its error answer
      r.status = e.code
      r.body = { error: e.name, error_description: e.message }
    }
    res
      .status(r.status ?? 200)
      .set(r.headers)
      .json(r.body)
  }

  /** RFC 7662: the caller's own live tokens are `active`; anything else (another client's) is not. */
  async introspect(req: Request, res: Response): Promise<void> {
    const body = tokenAuthForm.safeParse(req.body)
    if (!body.success) return void invalidRequest(res)
    const c = await this.caller(req, body.data)
    if (!c) return void this.unauthorized(res)
    const t = await this.tokens.inspect(body.data.token)
    res.set(NO_STORE)
    if (!t || t.session.clientId !== c.clientId) return void res.json({ active: false })
    const s = t.session
    res.json({
      active: true,
      client_id: s.clientId,
      scope: s.scopes.join(' '),
      ...(t.kind === 'access' && { token_type: 'Bearer' }),
      exp: secs(t.expiresAt),
      ...(s.userId !== null && { sub: String(s.userId), username: s.username }),
    })
  }

  /**
   * RFC 7009: an access or refresh token of the caller ends its whole session; an unknown or another
   * client's token changes nothing. Always 200 once the client is authenticated.
   */
  async revoke(req: Request, res: Response): Promise<void> {
    const body = tokenAuthForm.safeParse(req.body)
    if (!body.success) return void invalidRequest(res)
    const c = await this.caller(req, body.data)
    if (!c) return void this.unauthorized(res)
    const t = await this.tokens.inspect(body.data.token)
    if (t && t.session.clientId === c.clientId)
      await this.revoker.revokeSession(t.session.sid, 'oauth_revoked')
    res.status(200).end()
  }

  /** Client authentication of introspect/revoke: HTTP Basic, else `client_id` + `client_secret`. */
  private caller(req: Request, body: { client_id?: string; client_secret?: string }) {
    const b = basic(req.get('authorization'))
    return b
      ? this.authenticate(b.id, b.secret)
      : this.authenticate(body.client_id ?? '', body.client_secret)
  }

  private unauthorized(res: Response) {
    res
      .status(401)
      .set({ ...NO_STORE, 'WWW-Authenticate': 'Basic realm="oauth2"' })
      .json({ error: 'invalid_client' })
  }
}
