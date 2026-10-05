// The committed env files never assign a credential. In .env.example it matters
// beyond secrecy: the server takes the FIRST env file that defines a key (.env before .env.local) and
// EnvSchema drops '' only after that merge, so a `cp .env.example .env` that still says `APP_SECRET=`
// hid the real APP_SECRET in .env.local and the server refused to start.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { Test } from '@nestjs/testing'
import { AppConfigService, CoreConfigModule } from '../../src/core/config/config.module.js'
import { EnvSchema } from '../../src/core/config/env.schema.js'

/** .env.local only; the test/e2e files may keep their throwaway APP_SECRET / SEED_ADMIN_PASSWORD */
const ACCOUNTS = [
  'DB_USER',
  'DB_PASSWORD',
  'REDIS_USERNAME',
  'REDIS_PASSWORD',
  'WX_MP_APPID',
  'WX_MP_SECRET',
]
const CREDENTIALS = [...ACCOUNTS, 'APP_SECRET', 'SEED_ADMIN_PASSWORD']
const read = (file: string) => readFileSync(file, 'utf8')

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it('.env.example assigns no credential (not even empty) and lists each one as a comment', () => {
  const text = read('.env.example')
  const assigned = Object.keys(parseEnv(text))
  for (const key of CREDENTIALS) {
    expect(Object.keys(EnvSchema.out.shape)).toContain(key)
    expect(assigned).not.toContain(key)
    expect(text).toMatch(new RegExp(`^#.*\\b${key}\\b`, 'm'))
  }
  for (const file of ['.env.test', '.env.e2e'])
    expect(Object.keys(parseEnv(read(file))).filter((k) => ACCOUNTS.includes(k))).toEqual([])
})

it('cp .env.example .env + credentials in .env.local → the server config validates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qw-env-example-'))
  try {
    const local = {
      APP_SECRET: 'local-app-secret-not-for-production-0123456789-abcdefghij',
      DB_USER: 'local-db-user',
      DB_PASSWORD: 'local-db-password-not-for-production',
      REDIS_USERNAME: 'local-redis-user',
      REDIS_PASSWORD: 'local-redis-password-not-for-production',
      SEED_ADMIN_PASSWORD: 'Local@12345-not-for-production',
    }
    writeFileSync(join(dir, '.env'), read('.env.example'))
    writeFileSync(
      join(dir, '.env.local'),
      Object.entries(local)
        .map(([k, v]) => `${k}=${v}\n`)
        .join(''),
    )
    // the files alone decide: no process env (it wins over both) and the default mode file `.env`
    for (const key of ['ENV_FILE', ...Object.keys(EnvSchema.out.shape)]) vi.stubEnv(key, undefined)
    vi.spyOn(process, 'cwd').mockReturnValue(dir) // envFiles() resolves .env and .env.local from cwd

    const cfg = (
      await Test.createTestingModule({ imports: [CoreConfigModule.forRoot()] }).compile()
    ).get(AppConfigService)
    for (const [key, value] of Object.entries(local))
      expect(cfg.get(key as keyof typeof local)).toBe(value)
    expect(cfg.get('DB_NAME')).toBe('qiwu_dev') // dev config still from .env
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
