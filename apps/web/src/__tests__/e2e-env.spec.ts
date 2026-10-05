// @vitest-environment node
// Playwright server env (e2e/env.ts): `.env.local`, `.env.e2e`, then an optional git-ignored
// `.env.e2e.local` (a parallel checkout's own database, Redis db and ports); the run refuses a DB_NAME
// without the `_e2e` suffix, since the server command drops and reseeds it.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { e2eServerEnv } from '../../e2e/env.ts'

let dir: string
const write = (name: string, body: string) => writeFileSync(join(dir, name), body)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qw-e2e-env-'))
  write('.env.local', 'DB_USER=u\nDB_NAME=qiwu_dev\n')
  write('.env.e2e', 'DB_NAME=qiwu_e2e\nREDIS_DB=14\nPORT=3200\n')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('e2e server env', () => {
  it('without .env.e2e.local: the committed mode file over the credentials', () => {
    expect(e2eServerEnv(dir)).toEqual({
      DB_USER: 'u',
      DB_NAME: 'qiwu_e2e',
      REDIS_DB: '14',
      PORT: '3200',
      ENV_FILE: '.env.e2e',
    })
  })

  it('.env.e2e.local is layered last', () => {
    write('.env.e2e.local', 'DB_NAME=qiwu_alt_e2e\nREDIS_DB=8\nPORT=3202\nE2E_WEB_PORT=4174\n')
    expect(e2eServerEnv(dir)).toMatchObject({
      DB_USER: 'u',
      DB_NAME: 'qiwu_alt_e2e',
      REDIS_DB: '8',
      PORT: '3202',
      E2E_WEB_PORT: '4174',
      ENV_FILE: '.env.e2e',
    })
  })

  it.each(['qiwu_dev', 'qiwu_test', 'qiwu_e2e_old', ''])('refuses DB_NAME %j', (name) => {
    write('.env.e2e.local', `DB_NAME=${name}\n`)
    expect(() => e2eServerEnv(dir)).toThrow(/_e2e/)
  })
})
