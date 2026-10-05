import OAuth2Server from '@node-oauth/oauth2-server'
import type { PermVersion } from '../../../../core/auth/perm-version.js'
import type { SessionRevoker } from '../../../../core/auth/session-revoker.js'
import type {
  Issued,
  IssuedTokens,
  Session,
  SessionUser,
  TokenService,
} from '../../../../core/auth/token.service.js'
import type { ClientRow } from './provider.service.js'

/** What the model needs from the provider (client authentication) and core/auth. */
export interface ModelDeps {
  authenticate: (clientId: string, secret: string | undefined) => Promise<ClientRow | null>
  clientEnabled: (id: number) => Promise<boolean>
  tokens: TokenService
  revoker: SessionRevoker
  permVersion: PermVersion
}

/** The library's "user" of each grant: who the session is for, as the getters found it. */
type GrantUser =
  | { kind: 'code'; userId: number; credVer: string }
  | { kind: 'refresh'; session: Session; tokens: IssuedTokens }
  | { kind: 'client' }

/** client_credentials sessions belong to no user: AuthGuard sets no principal, PermGuard never passes. */
const MACHINE: SessionUser = {
  userId: null,
  userType: 'client',
  deptId: null,
  deptTreePath: null,
  roles: [],
  perms: [],
  locale: null,
  permVer: '',
}

type Model = Omit<OAuth2Server.AuthorizationCodeModel, 'saveAuthorizationCode'> &
  OAuth2Server.RefreshTokenModel &
  OAuth2Server.ClientCredentialsModel

/**
 * The `@node-oauth/oauth2-server` model of one `/token` request (`at` = the caller's IP and UA). The
 * library authenticates the client, dispatches the grant, verifies PKCE and the redirect URI and writes
 * the RFC answer; every token it would mint is ignored: sessions and tokens are TokenService's (see docs/design-notes.md#auth-sessions),
 * so `saveToken` returns those. `getClient` runs first and keeps the authenticated client row here.
 */
export function oauthModel(deps: ModelDeps, at: { ip: string; ua: string }): Model {
  let authed: ClientRow | null = null
  const client = () => {
    if (!authed) throw new Error('oauthModel: no authenticated client')
    return authed
  }
  const answer = (
    t: IssuedTokens,
    scope: string[],
    user: GrantUser,
    withRefresh: boolean,
  ): OAuth2Server.Token => ({
    accessToken: t.accessToken,
    refreshToken: withRefresh ? t.refreshToken : undefined,
    scope,
    client: { id: client().clientId, grants: client().grants },
    user,
    // TokenService's exact lifetime as an extended attribute (allowExtendedTokenAttributes): the
    // library would recompute it from a Date a few ms later, one second short
    expires_in: t.expiresIn,
  })

  return {
    async getClient(clientId, secret) {
      authed = await deps.authenticate(clientId, secret)
      return (
        authed && { id: authed.clientId, grants: authed.grants, redirectUris: authed.redirectUris }
      )
    },

    async getAuthorizationCode(code) {
      // consumed here (GETDEL): of two concurrent exchanges one gets it, a failed one burns it
      const e = await deps.tokens.takeCode(code)
      const c = client()
      // the row it was issued to (a client re-registered under a deleted one's client_id cannot redeem
      // it), still listing its redirect URI; every code has an S256 challenge — the library would skip
      // PKCE for one without
      if (!e || e.clientPk !== c.id || !e.challenge || !c.redirectUris.includes(e.redirectUri))
        return null
      return {
        authorizationCode: code,
        expiresAt: new Date(e.exp),
        redirectUri: e.redirectUri,
        scope: e.scopes,
        codeChallenge: e.challenge,
        codeChallengeMethod: 'S256',
        client: { id: e.client, grants: [] },
        user: { kind: 'code', userId: e.userId, credVer: e.credVer } satisfies GrantUser,
      }
    },

    // getAuthorizationCode already consumed it
    revokeAuthorizationCode: async () => true,

    async getRefreshToken(refreshToken) {
      // Rotation happens here, on TokenService's single path (grace window, replay → the whole
      // session revoked, another client's token rejected untouched; see docs/design-notes.md#auth-sessions); errors the library raises after
      // this (scope widening) leave the new pair in the grace window for a retry.
      const r = await deps.tokens.refresh(refreshToken, at.ua, client().clientId)
      if (r.kind !== 'rotated') return null
      return {
        refreshToken,
        scope: r.session.scopes,
        client: { id: r.session.clientId, grants: [] },
        user: { kind: 'refresh', session: r.session, tokens: r.tokens } satisfies GrantUser,
      }
    },

    // getRefreshToken already rotated it
    revokeToken: async () => true,

    getUserFromClient: async () => ({ kind: 'client' }) satisfies GrantUser,

    /** A code's scopes (re-checked against the client's current ones) or client_credentials' request. */
    async validateScope(user, _client, scope) {
      const allowed = client().scopes
      const s = [...new Set(scope ?? ((user as GrantUser).kind === 'client' ? allowed : []))]
      return s.length && s.every((x) => allowed.includes(x)) ? s : false
    },

    async saveToken(token, _client, user) {
      const g = user as GrantUser
      const c = client()
      if (g.kind === 'refresh') return answer(g.tokens, g.session.scopes, g, true)
      const scopes = token.scope ?? []
      const accessMs = c.accessTtl * 1000
      const refreshable = c.grants.includes('refresh_token')
      const base = { clientId: c.clientId, scopes, keepSignedIn: false, ...at }
      let issued: Issued | null
      if (g.kind === 'code') {
        const u = await deps.permVersion.load(g.userId)
        // the user is gone or disabled, or revoked (password change, kick…) since the code was issued
        issued =
          u &&
          (await deps.tokens.issue(u, {
            ...base,
            credVer: g.credVer,
            ttl: { accessMs, refreshMs: refreshable ? c.refreshTtl * 1000 : accessMs },
          }))
        if (!issued)
          throw new OAuth2Server.InvalidGrantError('Invalid grant: authorization code is invalid')
      } else
        // issue() mints a refresh token nobody sees; it dies with the session (= access TTL)
        issued = await deps.tokens.issue(MACHINE, {
          ...base,
          ttl: { accessMs, refreshMs: accessMs },
        })
      // A disable/delete may have revoked its snapshot before this session was issued.
      if (!(await deps.clientEnabled(c.id))) {
        await deps.revoker.revokeSession(issued.session.sid, 'client_disabled')
        throw new OAuth2Server.InvalidClientError('Invalid client: client is disabled or deleted')
      }
      return answer(issued, scopes, g, g.kind === 'code' && refreshable)
    },

    // required by the types only: server.authenticate() is never called (AuthGuard authenticates)
    getAccessToken: async () => false,
  }
}
