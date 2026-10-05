// core/config: EnvSchema validation, typed AppConfigService, env-file layering, and the
// HTTP setup that reads it (setupApp: trust proxy, helmet, cookie-parser, Swagger at /api/docs).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { Controller, Get, Req } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { DEFAULT_PASSWORD_POLICY, passwordSchema } from '@qiwu/shared'
import type { Request } from 'express'
import request from 'supertest'
import { setupApp } from '../../src/app.setup.js'
import { AppConfigService, CoreConfigModule } from '../../src/core/config/config.module.js'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { envFiles } from '../../src/core/paths.js'

const configOf = async () =>
  (await Test.createTestingModule({ imports: [CoreConfigModule.forRoot()] }).compile()).get(
    AppConfigService,
  )

const productionSecretFixture = 'production-secret-fixture-0123456789abcdef'
const markerFixture = 'prefix-NoT-FoR-PrOdUcTiOn-suffix-0123456789'

afterEach(() => vi.unstubAllEnvs())

describe('EnvSchema', () => {
  it.each(['.env.test', '.env.e2e'])(
    '%s marks both committed credentials and its admin password satisfies the default policy',
    (file) => {
      const fixture = parseEnv(readFileSync(file, 'utf8'))
      expect(
        passwordSchema(DEFAULT_PASSWORD_POLICY).safeParse(fixture.SEED_ADMIN_PASSWORD).success,
      ).toBe(true)
      for (const field of ['APP_SECRET', 'SEED_ADMIN_PASSWORD'] as const) {
        expect(fixture[field]).toMatch(/not-for-production/i)
        const parsed = EnvSchema.safeParse({
          NODE_ENV: 'production',
          DB_USER: 'fixture',
          DB_NAME: 'fixture_test',
          APP_SECRET: productionSecretFixture,
          [field]: fixture[field],
        })
        expect(parsed.success).toBe(false)
        expect(parsed.error?.issues).toEqual([
          expect.objectContaining({
            path: [field],
            message: expect.stringContaining('test marker'),
          }),
        ])
      }
    },
  )

  it('reports both marked production fields as separate issues', () => {
    const parsed = EnvSchema.safeParse({
      ...process.env,
      NODE_ENV: 'production',
      APP_SECRET: markerFixture,
      SEED_ADMIN_PASSWORD: markerFixture,
    })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([
      ['APP_SECRET'],
      ['SEED_ADMIN_PASSWORD'],
    ])
  })

  it.each([
    ['missing', undefined],
    ['empty (`APP_SECRET=`)', ''],
    ['shorter than 32 chars', 'x'.repeat(31)],
  ])('APP_SECRET %s → config load (startup) fails', async (_, value) => {
    const cwd = mkdtempSync(join(tmpdir(), 'qw-no-secret-'))
    const mockCwd = vi.spyOn(process, 'cwd').mockReturnValue(cwd)
    try {
      vi.stubEnv('ENV_FILE', 'no-such-env-file') // neither this nor .env.local exists in cwd
      vi.stubEnv('APP_SECRET', value)
      await expect(configOf()).rejects.toThrow(/Config validation error: APP_SECRET/)
    } finally {
      mockCwd.mockRestore()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.each(['APP_SECRET', 'SEED_ADMIN_PASSWORD'] as const)(
    'production rejects the test marker in %s without exposing credentials',
    async (field) => {
      vi.stubEnv('NODE_ENV', 'production')
      vi.stubEnv('APP_SECRET', productionSecretFixture)
      vi.stubEnv('SEED_ADMIN_PASSWORD', '')
      vi.stubEnv(field, markerFixture)
      const failure = await configOf().then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(Error)
      const message = (failure as Error).message
      expect(message).toContain(
        `Config validation error: ${field}: production credentials must not contain the test marker`,
      )
      expect(message).not.toContain(markerFixture)
      expect(message).not.toContain(productionSecretFixture)
    },
  )

  it('production accepts a non-marker secret with SEED_ADMIN_PASSWORD unset', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('APP_SECRET', productionSecretFixture)
    vi.stubEnv('SEED_ADMIN_PASSWORD', '')
    const cfg = await configOf()
    expect(cfg.get('APP_SECRET')).toBe(productionSecretFixture)
    expect(
      EnvSchema.parse({
        NODE_ENV: 'production',
        APP_SECRET: productionSecretFixture,
        DB_USER: 'fixture',
        DB_NAME: 'fixture_test',
      }).SEED_ADMIN_PASSWORD,
    ).toBeUndefined()
  })

  it.each(['development', 'test'])(
    '%s accepts test/e2e credentials and markers in both fields',
    async (mode) => {
      vi.stubEnv('NODE_ENV', mode)
      for (const file of ['.env.test', '.env.e2e']) {
        const fixture = parseEnv(readFileSync(file, 'utf8'))
        vi.stubEnv('APP_SECRET', fixture.APP_SECRET)
        vi.stubEnv('SEED_ADMIN_PASSWORD', fixture.SEED_ADMIN_PASSWORD)
        const cfg = await configOf()
        expect(cfg.get('APP_SECRET')).toBe(fixture.APP_SECRET)
        expect(cfg.get('SEED_ADMIN_PASSWORD')).toBe(fixture.SEED_ADMIN_PASSWORD)
      }
      vi.stubEnv('APP_SECRET', markerFixture)
      vi.stubEnv('SEED_ADMIN_PASSWORD', markerFixture)
      const cfg = await configOf()
      expect(cfg.get('APP_SECRET')).toBe(markerFixture)
      expect(cfg.get('SEED_ADMIN_PASSWORD')).toBe(markerFixture)
    },
  )

  it('rejects malformed values instead of guessing', async () => {
    vi.stubEnv('SWAGGER_ENABLED', 'maybe')
    await expect(configOf()).rejects.toThrow(/SWAGGER_ENABLED/)
    vi.stubEnv('SWAGGER_ENABLED', 'true')
    vi.stubEnv('REDIS_KEY_PREFIX', 'qw') // must end with ':'
    await expect(configOf()).rejects.toThrow(/REDIS_KEY_PREFIX/)
  })

  it('outbound port lists (see docs/design-notes.md#security): port numbers only, comma or space separated, none by default', async () => {
    vi.stubEnv('OUTBOUND_S3_PORTS', '9000, 8333  9443')
    vi.stubEnv('OUTBOUND_SMTP_PORTS', '')
    const cfg = await configOf()
    expect(cfg.get('OUTBOUND_S3_PORTS')).toEqual([9000, 8333, 9443])
    expect(cfg.get('OUTBOUND_SMTP_PORTS')).toEqual([])
    for (const bad of ['9000,abc', '70000', '0', '80.5', '-1', 'all', '0x16', '1e3', '+80']) {
      vi.stubEnv('OUTBOUND_S3_PORTS', bad)
      await expect(configOf()).rejects.toThrow(/OUTBOUND_S3_PORTS/)
    }
  })

  it('AppConfigService returns parsed, typed values with defaults', async () => {
    vi.stubEnv('ACCESS_TTL_SEC', undefined)
    vi.stubEnv('APP_DEMO_MODE', '')
    const cfg = await configOf()
    // a parallel checkout's .env.test.local sets its own PORT / REDIS_DB
    expect(cfg.get('PORT')).toBe(Number(process.env.PORT))
    expect(cfg.get('SWAGGER_ENABLED')).toBe(true)
    expect(cfg.get('ALLOW_PRIVATE_ENDPOINTS')).toBe(true)
    expect(cfg.get('APP_DEMO_MODE')).toBe(false)
    expect(cfg.get('ACCESS_TTL_SEC')).toBe(1800)
    expect(cfg.get('REDIS_DB')).toBe(Number(process.env.REDIS_DB))
    expect(cfg.get('REDIS_KEY_PREFIX')).toBe('qw:')
    expect(cfg.get('TRUST_PROXY')).toBe('loopback')
  })
})

describe('env files', () => {
  let dir: string
  beforeAll(() => (dir = mkdtempSync(join(tmpdir(), 'qw-config-'))))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('mode file (ENV_FILE) first, then .env.local; the process env wins over both', () => {
    vi.stubEnv('ENV_FILE', '.env.e2e')
    expect(envFiles()).toEqual([join(process.cwd(), '.env.e2e'), join(process.cwd(), '.env.local')])
    vi.stubEnv('ENV_FILE', undefined)
    expect(envFiles()[0]).toBe(join(process.cwd(), '.env'))
  })

  it('a key in the mode file beats .env.local; .env.local fills what the mode file lacks', async ({
    skip,
  }) => {
    skip(!existsSync('.env.local'), 'no .env.local (credentials) on this machine')
    const local = parseEnv(readFileSync('.env.local', 'utf8'))
    const modeFile = join(dir, '.env.mode')
    writeFileSync(modeFile, 'DB_USER=from-mode-file\nCORS_ORIGIN=http://mode.test\n')
    vi.stubEnv('ENV_FILE', modeFile)
    for (const key of ['DB_USER', 'DB_PASSWORD', 'CORS_ORIGIN']) vi.stubEnv(key, undefined)
    const cfg = await configOf()
    expect(cfg.get('DB_USER')).toBe('from-mode-file')
    expect(cfg.get('CORS_ORIGIN')).toBe('http://mode.test')
    expect(cfg.get('DB_PASSWORD')).toBe(local.DB_PASSWORD)
  })

  // the real process: `node dist/main.js` must exit (not serve) without a valid APP_SECRET
  it('dist/main.js exits non-zero without APP_SECRET', ({ skip }) => {
    skip(!existsSync('dist/main.js'), 'no dist: pnpm --filter @qiwu/server build first')
    const r = spawnSync(process.execPath, ['dist/main.js'], {
      env: { ...process.env, APP_SECRET: '', ENV_FILE: '.env.test' },
      encoding: 'utf8',
      timeout: 20_000,
    })
    expect(r.status).not.toBe(0)
    expect(r.status).not.toBeNull() // null = killed by the timeout, i.e. it booted
    expect(r.stderr).toMatch(/Config validation error[\s\S]*APP_SECRET/)
  })

  describe.skipIf(!existsSync('dist/main.js'))('production startup', () => {
    it.each(['APP_SECRET', 'SEED_ADMIN_PASSWORD'] as const)(
      'dist/main.js exits non-zero for the production marker in %s without leaking credentials',
      (field) => {
        const r = spawnSync(process.execPath, ['dist/main.js'], {
          env: {
            ...process.env,
            NODE_ENV: 'production',
            APP_SECRET: productionSecretFixture,
            SEED_ADMIN_PASSWORD: '',
            ENV_FILE: '.env.test',
            [field]: markerFixture,
          },
          encoding: 'utf8',
          timeout: 20_000,
        })
        expect(r.error).toBeUndefined()
        expect(r.status).not.toBe(0)
        expect(r.status).not.toBeNull()
        const output = r.stdout + r.stderr
        expect(output).toContain(
          `Config validation error: ${field}: production credentials must not contain the test marker`,
        )
        expect(output).not.toContain(markerFixture)
        expect(output).not.toContain(productionSecretFixture)
      },
    )
  })
})

@Controller('probe')
class ProbeController {
  @Get()
  probe(@Req() req: Request) {
    return { ip: req.ip, cookies: req.cookies }
  }
}

describe('setupApp: trust proxy, helmet, cookie-parser, Swagger', () => {
  const start = async (env: Record<string, string> = {}) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
    const moduleRef = await Test.createTestingModule({
      imports: [CoreConfigModule.forRoot()],
      controllers: [ProbeController],
    }).compile()
    const app = setupApp(moduleRef.createNestApplication<NestExpressApplication>())
    await app.listen(0, '127.0.0.1')
    return app
  }

  it('trusts X-Forwarded-For from loopback (default), parses cookies, sets helmet headers', async () => {
    const app = await start()
    try {
      const res = await request(app.getHttpServer())
        .get('/api/probe')
        .set('X-Forwarded-For', '203.0.113.9')
        .set('Cookie', 'a=1')
        .expect(200)
      expect(res.body).toEqual({ ip: '203.0.113.9', cookies: { a: '1' } })
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['content-security-policy']).toContain("default-src 'self'")
      expect(res.headers['content-security-policy']).toContain('upgrade-insecure-requests')
    } finally {
      await app.close()
    }
  })

  it('ignores a forged X-Forwarded-For when TRUST_PROXY does not list the peer', async () => {
    const app = await start({ TRUST_PROXY: '10.9.9.9' })
    try {
      const res = await request(app.getHttpServer())
        .get('/api/probe')
        .set('X-Forwarded-For', '203.0.113.9')
      expect(res.body.ip).toBe('127.0.0.1')
    } finally {
      await app.close()
    }
  })

  it('serves Swagger at /api/docs with the relaxed CSP only there', async () => {
    const app = await start()
    try {
      const ui = await request(app.getHttpServer()).get('/api/docs').expect(200)
      expect(ui.headers['content-type']).toMatch(/text\/html/)
      expect(ui.headers['content-security-policy']).toContain("script-src 'self'")
      expect(ui.headers['content-security-policy']).not.toContain('upgrade-insecure-requests')
      const doc = await request(app.getHttpServer()).get('/api/docs-json').expect(200)
      expect(Object.keys(doc.body.paths)).toContain('/api/probe')
      expect(doc.headers['content-security-policy']).toContain('upgrade-insecure-requests')
    } finally {
      await app.close()
    }
  })

  it('has no /api/docs when SWAGGER_ENABLED=false', async () => {
    const app = await start({ SWAGGER_ENABLED: 'false' })
    try {
      expect((await request(app.getHttpServer()).get('/api/docs')).status).toBe(404)
    } finally {
      await app.close()
    }
  })
})
