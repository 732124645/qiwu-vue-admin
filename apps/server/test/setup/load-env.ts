// Vitest setupFiles: .env.local (git-ignored credentials) then the committed .env.test, so test config
// wins on overlap and credentials exist only in .env.local. Same layering as scripts/smoke-boot.mjs.
// An optional git-ignored .env.test.local comes last and wins: a parallel checkout points DB_NAME /
// REDIS_DB / PORT at its own test database there.
import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

const serverDir = new URL('../../', import.meta.url)

for (const file of ['.env.local', '.env.test', '.env.test.local']) {
  const url = new URL(file, serverDir)
  if (existsSync(url)) Object.assign(process.env, parseEnv(readFileSync(url, 'utf8')))
}
