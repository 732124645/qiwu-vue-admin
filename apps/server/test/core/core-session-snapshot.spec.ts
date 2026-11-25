import { SessionCurrent } from '../../src/core/auth/session-current.js'
import type { PermVersion } from '../../src/core/auth/perm-version.js'
import type { SessionRevoker } from '../../src/core/auth/session-revoker.js'
import type { TenantLookup } from '../../src/core/auth/tenant-lookup.js'
import { TokenService, type Session } from '../../src/core/auth/token.service.js'
import type { AppConfigService } from '../../src/core/config/config.module.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import type { Redis } from '../../src/core/redis/redis.module.js'
import type { ParamService } from '../../src/core/settings/param.service.js'

const session = (): Session => ({
  sid: 'live-session',
  userId: 7,
  userType: 'admin',
  tenantId: 1,
  root: false,
  deptId: null,
  deptTreePath: null,
  roles: [],
  perms: [],
  locale: 'en-US',
  permVer: '0.0',
  clientId: 'console',
  scopes: [],
  flags: { mustChangePassword: false, passwordExpired: false },
  keepSignedIn: false,
  ip: '127.0.0.1',
  ua: 'fixture',
  loginAt: Date.now(),
  absoluteExpAt: Date.now() + 60_000,
})
const tenants = () => ({
  active: vi.fn<TenantLookup['active']>(async () => true),
  byHost: vi.fn<TenantLookup['byHost']>(async () => null),
  byCode: vi.fn<TenantLookup['byCode']>(async () => null),
  brand: vi.fn<TenantLookup['brand']>(async () => null),
})

function setup(value: Session | null = session()) {
  const rows = new Map<string, string>()
  if (value) rows.set(redisKey('authSession', 'live-session'), JSON.stringify(value))
  const get = vi.fn<(key: string) => Promise<string | null>>(async (key) => rows.get(key) ?? null)
  const revokeSession = vi.fn<SessionRevoker['revokeSession']>(async () => null)
  const cfg = { get: (key: string) => key === 'APP_MULTI_TENANT' }
  const tokens = new TokenService(
    { get } as unknown as Redis,
    cfg as unknown as AppConfigService,
    { revokeSession } as unknown as SessionRevoker,
    {} as ParamService,
  )
  return { rows, get, revokeSession, tokens }
}

it('reads an unchanged live snapshot without refreshing, deleting or revoking credentials', async () => {
  const value = session()
  const test = setup(value)
  expect(await test.tokens.readLiveSnapshot(value.sid)).toEqual(value)
  expect(test.get).toHaveBeenCalledExactlyOnceWith(redisKey('authSession', value.sid))
  expect(test.rows.size).toBe(1)
  expect(test.revokeSession).not.toHaveBeenCalled()
})

it.each(['missing', 'expired', 'tenant-expired', 'different-sid'] as const)(
  'refuses a %s snapshot while keeping the read path free of revocation side effects',
  async (mode) => {
    const value = session()
    if (mode === 'expired') value.absoluteExpAt = Date.now() - 1
    if (mode === 'tenant-expired') value.tenantExpAt = Date.now() - 1
    if (mode === 'different-sid') value.sid = 'another-session'
    const test = setup(mode === 'missing' ? null : value)
    const before = [...test.rows]
    expect(await test.tokens.readLiveSnapshot('live-session')).toBeNull()
    expect([...test.rows]).toEqual(before)
    expect(test.revokeSession).not.toHaveBeenCalled()
  },
)

it('compares current permission version without invoking the full session reload under a business lock', async () => {
  const value = session()
  const test = setup(value)
  const version = vi.fn<PermVersion['current']>(async () => '0.0')
  const load = vi.fn<PermVersion['load']>()
  const current = new SessionCurrent(
    { current: version, load } as unknown as PermVersion,
    test.tokens,
    { revokeSession: test.revokeSession } as unknown as SessionRevoker,
    tenants(),
  )
  const reload = vi.spyOn(current, 'current')
  expect(await current.unchanged(value)).toBe(true)
  version.mockResolvedValue('1.0')
  expect(await current.unchanged(value)).toBe(false)
  expect(load).not.toHaveBeenCalled()
  expect(reload).not.toHaveBeenCalled()
  expect(test.revokeSession).not.toHaveBeenCalled()
})

it.each([
  'owner',
  'client',
  'tenant',
  'acting',
  'cached-version',
  'password-change',
  'password-expired',
] as const)(
  'rejects a changed %s snapshot rather than treating cached session presence as fresh authorization',
  async (mode) => {
    const expected = session()
    const live = structuredClone(expected)
    if (mode === 'owner') live.userId = 8
    if (mode === 'client') live.clientId = 'mobile'
    if (mode === 'tenant') live.tenantId = 2
    if (mode === 'acting') live.actingTenantId = 2
    if (mode === 'cached-version') live.permVer = '1.0'
    if (mode === 'password-change') live.flags.mustChangePassword = true
    if (mode === 'password-expired') live.flags.passwordExpired = true
    const test = setup(live)
    const current = new SessionCurrent(
      { current: vi.fn<PermVersion['current']>(async () => '0.0') } as unknown as PermVersion,
      test.tokens,
      { revokeSession: test.revokeSession } as unknown as SessionRevoker,
      tenants(),
    )
    expect(await current.unchanged(expected)).toBe(false)
    expect(test.revokeSession).not.toHaveBeenCalled()
  },
)
