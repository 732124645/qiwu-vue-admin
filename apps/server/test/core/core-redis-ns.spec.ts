// core/redis: the key registry is the only key builder (prefix qw:), the client
// comes from config (ACL user, db 15 in tests) and closes on shutdown; specs clean up with
// SCAN MATCH qw:* + UNLINK, never FLUSHDB.
import { Test, type TestingModule } from '@nestjs/testing'
import { CoreConfigModule } from '../../src/core/config/config.module.js'
import { CACHE_NAMESPACES, keyPattern, redisKey } from '../../src/core/redis/cache-namespaces.js'
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

  it('registers the cache namespaces (+ auth:sess:, auth:seen, core/auth; excel:report:, core/excel; dict:ver:, param:ver:) once each; auth:* is never clearable', () => {
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
      ].sort(),
    )
    const clearableAuth = Object.values(CACHE_NAMESPACES).filter(
      (n) => n.prefix.startsWith('auth:') && n.clearable,
    )
    expect(clearableAuth).toEqual([])
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
