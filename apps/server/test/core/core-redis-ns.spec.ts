// core/redis: the key registry is the only key builder (prefix qw:), the client
// comes from config (ACL user, db 15 in tests) and closes on shutdown; specs clean up with
// SCAN MATCH qw:* + UNLINK, never FLUSHDB.
import { Test, type TestingModule } from '@nestjs/testing'
import { CACHE_KEY_TENANCIES } from '@qiwu/shared'
import { CoreConfigModule } from '../../src/core/config/config.module.js'
import { allTenants, TenantContextMissing, withTenant } from '../../src/core/context/tenant.js'
import {
  CACHE_NAMESPACES,
  type CacheNamespace,
  type CacheNamespaceName,
  keyPattern,
  keyPatternAllTenants,
  redisKey,
} from '../../src/core/redis/cache-namespaces.js'
import { CoreRedisModule, REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { cleanRedis } from '../setup/redis.js'

describe('cache-namespaces', () => {
  it('builds prefix + namespace + parts', () => {
    expect(redisKey('authAccess', 'abc')).toBe('qw:auth:at:abc')
    expect(redisKey('authFail', 'ip', '10.0.0.1')).toBe('qw:auth:fail:ip:10.0.0.1')
    expect(redisKey('jobFire', 7, 1790000000000)).toBe('qw:job:fire:7:1790000000000')
    expect(redisKey('authOnline')).toBe('qw:auth:online')
    expect(keyPattern()).toBe('qw:*')
    expect(keyPattern('dict')).toBe('qw:dict:*')
  })

  it('encodes parts: a client-supplied `:` cannot forge another key shape', () => {
    // username "ip:10.0.0.1" must not collide with the per-IP bucket
    expect(redisKey('authFail', 'ip:10.0.0.1', '10.0.0.2')).toBe(
      'qw:auth:fail:ip%3A10.0.0.1:10.0.0.2',
    )
    expect(redisKey('idem', 's1', 'POST', '/api/x?a=1 b')).toBe(
      'qw:idem:s1:POST:%2Fapi%2Fx%3Fa%3D1%20b',
    )
  })

  it('registers the cache namespaces (+ auth:sess:, auth:seen, core/auth; excel:report:, core/excel; dict:ver:, param:ver:; queue:, core/queue) once each; auth:* is never clearable', () => {
    const prefixes = Object.values(CACHE_NAMESPACES).map((n) => n.prefix)
    expect(new Set(prefixes).size).toBe(prefixes.length)
    expect(prefixes.sort()).toEqual(
      [
        'auth:sess:',
        'auth:at:',
        'auth:rt:',
        'auth:rt:grace:',
        'auth:user:',
        'auth:codes:',
        'auth:online',
        'auth:seen',
        'auth:permver:',
        'auth:credver:',
        'auth:acting-leave:',
        'auth:fail:',
        'captcha:',
        'sms:limit:',
        'wxmp:',
        'oauth2:code:',
        'presign:',
        'dict:',
        'dict:ver:',
        'param:',
        'param:ver:',
        'idem:',
        'throttle:',
        'excel:report:',
        'lock:',
        'job:lock:',
        'job:fire:',
        'queue:',
      ].sort(),
    )
    const clearableAuth = Object.values(CACHE_NAMESPACES).filter(
      (n) => n.prefix.startsWith('auth:') && n.clearable,
    )
    expect(clearableAuth).toEqual([])
  })

  it('declares every namespace’s tenant dimension; none is per tenant yet', () => {
    const declared = Object.fromEntries(
      Object.entries(CACHE_NAMESPACES).map(([name, n]) => [name, n.tenancy]),
    )
    for (const t of Object.values(declared)) expect(CACHE_KEY_TENANCIES).toContain(t)
    const platform = ['dict', 'dictVer', 'param', 'paramVer', 'throttle', 'jobLock', 'jobFire']
    expect(declared).toEqual(
      Object.fromEntries(
        Object.keys(CACHE_NAMESPACES).map((name) => [
          name,
          platform.includes(name) ? 'platform' : 'global-id',
        ]),
      ),
    )
  })

  it('global-id and platform keys are byte for byte the same in any context: no tenant segment', () => {
    const keys = () => [
      redisKey('lock', 'job', 7),
      redisKey('smsLimit', 'cooldown', '13900009001'),
      redisKey('smsLimit', 'ip', '2026-10-07', '10.0.0.1'),
      redisKey('authFail', 'p', 'alice', '10.0.0.1'),
      redisKey('dict', 'entries', 'iam.gender'),
      redisKey('jobFire', 7, 1),
      keyPattern('lock'),
      keyPattern('smsLimit'),
      keyPattern('param'),
    ]
    const expected = [
      'qw:lock:job:7',
      'qw:sms:limit:cooldown:13900009001',
      'qw:sms:limit:ip:2026-10-07:10.0.0.1',
      'qw:auth:fail:p:alice:10.0.0.1',
      'qw:dict:entries:iam.gender',
      'qw:job:fire:7:1',
      'qw:lock:*',
      'qw:sms:limit:*',
      'qw:param:*',
    ]
    expect(keys()).toEqual(expected)
    expect(withTenant(2, keys)).toEqual(expected)
    expect(allTenants(keys)).toEqual(expected)
  })

  describe('a tenant namespace (registered here for the duration: the registry has none yet)', () => {
    // the key builders take registered names only
    const byName = 'specByName' as CacheNamespaceName
    const registry = CACHE_NAMESPACES as unknown as Record<string, CacheNamespace>

    beforeAll(() => {
      registry[byName] = {
        prefix: 'spec:by-name:',
        clearable: true,
        masked: false,
        tenancy: 'tenant',
      }
    })

    afterAll(() => {
      delete registry[byName]
    })

    it('gets the context tenant’s segment right after its prefix, the default tenant too', () => {
      expect(withTenant(2, () => redisKey(byName, 'alice', 'x'))).toBe(
        'qw:spec:by-name:t:2:alice:x',
      )
      expect(withTenant(1, () => redisKey(byName, 'alice'))).toBe('qw:spec:by-name:t:1:alice')
      // an inner tenant wins over the outer one
      expect(withTenant(1, () => withTenant(2, () => redisKey(byName, 'a')))).toBe(
        'qw:spec:by-name:t:2:a',
      )
    })

    it('its scan pattern is the context tenant’s; the cache monitor’s for root spans every tenant', () => {
      expect(withTenant(2, () => keyPattern(byName))).toBe('qw:spec:by-name:t:2:*')
      expect(withTenant(1, () => keyPattern(byName))).toBe('qw:spec:by-name:t:1:*')
      expect(withTenant(2, () => keyPatternAllTenants(byName))).toBe('qw:spec:by-name:*')
      expect(keyPatternAllTenants('dict')).toBe('qw:dict:*')
    })

    it('throws without a tenant, and inside allTenants with no inner withTenant', () => {
      expect(() => redisKey(byName, 'alice')).toThrow(TenantContextMissing)
      expect(() => keyPattern(byName)).toThrow(TenantContextMissing)
      // not the outer tenant's segment either
      withTenant(2, () =>
        allTenants(() => {
          expect(() => redisKey(byName, 'alice')).toThrow(TenantContextMissing)
          expect(() => keyPattern(byName)).toThrow(TenantContextMissing)
          expect(withTenant(3, () => redisKey(byName, 'a'))).toBe('qw:spec:by-name:t:3:a')
        }),
      )
    })
  })

  it('uses REDIS_KEY_PREFIX', () => {
    vi.stubEnv('REDIS_KEY_PREFIX', 'other:')
    try {
      expect(redisKey('dict', 'core.enabled')).toBe('other:dict:core.enabled')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('CoreRedisModule', () => {
  let moduleRef: TestingModule
  let redis: Redis

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [CoreConfigModule.forRoot(), CoreRedisModule],
    }).compile()
    await moduleRef.init()
    redis = moduleRef.get(REDIS)
    await cleanRedis(redis)
  })

  afterAll(async () => {
    if (redis?.isOpen) await cleanRedis(redis)
    await moduleRef?.close()
  })

  it('connects with the configured user and db', async () => {
    expect(redis.isReady).toBe(true)
    expect(redis.options?.database).toBe(Number(process.env.REDIS_DB))
    const key = redisKey('dict', 'core-redis-ns')
    await redis.set(key, 'v', { EX: 60 })
    expect(await redis.get(key)).toBe('v')
  })

  it('the ACL user cannot touch keys outside qw:* (when an ACL user is configured)', async ({
    skip,
  }) => {
    skip(!process.env.REDIS_USERNAME, 'no ACL user in this environment')
    await expect(redis.get('core-redis-ns-outside')).rejects.toThrow(/NOPERM/)
  })

  it('cleanRedis removes every qw:* key via SCAN + UNLINK', async () => {
    const keys = Array.from({ length: 1200 }, (_, i) => redisKey('idem', 'clean', i))
    await redis.mSet(keys.map((k) => [k, '1'] as [string, string]))
    expect(await cleanRedis(redis)).toBeGreaterThanOrEqual(keys.length)
    let left = 0
    for await (const batch of redis.scanIterator({ MATCH: keyPattern(), COUNT: 500 }))
      left += batch.length
    expect(left).toBe(0)
  })

  it('closes the client on application shutdown', async () => {
    const ref = await Test.createTestingModule({
      imports: [CoreConfigModule.forRoot(), CoreRedisModule],
    }).compile()
    await ref.init()
    const client = ref.get<Redis>(REDIS)
    expect(client.isOpen).toBe(true)
    await ref.close()
    expect(client.isOpen).toBe(false)
  })
})
