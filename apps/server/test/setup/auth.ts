// Signing in for e2e specs without the login endpoint: a real session minted by TokenService for a
// seeded/created user (the same data AuthGuard reloads), so specs exercise the real guards.
import type { INestApplication } from '@nestjs/common'
import { getDataSourceToken } from '@nestjs/typeorm'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { PermVersion } from '../../src/core/auth/perm-version.js'
import { type IssueOptions, TokenService } from '../../src/core/auth/token.service.js'
import { withTenant } from '../../src/core/context/tenant.js'

/**
 * Starts a session for `username` (default: the seeded root `admin`) of tenant `tenantId` (default: the
 * default tenant; usernames are unique per tenant only); returns tokens + session.
 */
export async function signIn(
  app: INestApplication,
  username = 'admin',
  opts: Partial<IssueOptions> = {},
  tenantId = 1,
) {
  const [row] = await app
    .get<DataSource>(getDataSourceToken())
    .query<{ id: number }[]>(
      'SELECT id FROM iam_user WHERE username = ? AND tenant_id = ? AND deleted_at IS NULL',
      [username, tenantId],
    )
  if (!row) throw new Error(`signIn: no user '${username}' in tenant ${tenantId}`)
  return withTenant(tenantId, async () => {
    const user = await app.get(PermVersion).load(row.id)
    if (!user) throw new Error(`signIn: user '${username}' is disabled`)
    return app
      .get(TokenService)
      .issue(user, { keepSignedIn: false, ip: '127.0.0.1', ua: 'vitest', ...opts })
  })
}

/** `Authorization` header for supertest's `.set()`. */
export const bearer = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}` })

/** A supertest agent sending the access token of `username` (of tenant `tenantId`) with every request. */
export async function agentFor(app: INestApplication, username = 'admin', tenantId = 1) {
  const { accessToken } = await signIn(app, username, {}, tenantId)
  return request.agent(app.getHttpServer()).set(bearer(accessToken))
}
