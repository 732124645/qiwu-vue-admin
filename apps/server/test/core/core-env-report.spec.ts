// Startup env report: keys set in both env files (the first file wins) and the effective non-secret
// config line logged after listen.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EFFECTIVE_CONFIG_KEYS } from '../../src/core/config/env.schema.js'
import { effectiveConfigLine, envFileConflicts } from '../../src/core/config/env-report.js'

let dir: string
beforeAll(() => (dir = mkdtempSync(join(tmpdir(), 'qw-env-report-'))))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const file = (name: string, text: string) => {
  const path = join(dir, name)
  writeFileSync(path, text)
  return path
}

describe('envFileConflicts', () => {
  it('names the keys both files set to different values, never the values', () => {
    const mode = file('.env', 'PORT=3000\nMY_LIMIT=5\nSAME=1\nAPP_SECRET=mode-secret-value\n')
    const local = file(
      '.env.local',
      'PORT=4000\nMY_LIMIT=9\nSAME=1\nAPP_SECRET=local-secret-value\nDB_USER=u\n',
    )
    const message = envFileConflicts([mode, local])
    expect(message).toBe(
      'env: keys defined in both .env and .env.local, .env wins: APP_SECRET, MY_LIMIT, PORT',
    )
    for (const value of ['3000', '4000', '5', '9', 'mode-secret-value', 'local-secret-value'])
      expect(message).not.toContain(value)
  })

  it('nothing when the values agree or a file is missing', () => {
    const mode = file('.env.a', 'PORT=3000\n')
    expect(envFileConflicts([mode, file('.env.b', 'PORT=3000\nDB_USER=u\n')])).toBeUndefined()
    expect(envFileConflicts([mode, join(dir, 'missing')])).toBeUndefined()
    expect(envFileConflicts([join(dir, 'missing'), mode])).toBeUndefined()
  })
})

describe('effectiveConfigLine', () => {
  it('lists the configured keys from the validated config, then the process env', () => {
    const config: Record<string, unknown> = { NODE_ENV: 'production', PORT: 3000, APP_MCP: false }
    const line = effectiveConfigLine((k) => config[k], { NODE_APP_INSTANCE: '1', OTHER: 'x' })
    expect(line).toBe(
      'effective config: NODE_ENV=production PORT=3000 APP_MCP=false NODE_APP_INSTANCE=1',
    )
  })

  it('covers the startup keys a deployer checks first', () => {
    const all = Object.fromEntries(EFFECTIVE_CONFIG_KEYS.map((k) => [k, 'v']))
    const line = effectiveConfigLine((k) => all[k], {})
    for (const key of [
      'NODE_ENV',
      'PORT',
      'APP_MULTI_TENANT',
      'DB_NAME',
      'DB_POOL_SIZE',
      'REDIS_DB',
    ])
      expect(line).toContain(` ${key}=v`)
  })
})
