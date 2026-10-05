#!/usr/bin/env node
// Downloads the ip2region IPv4 data file (THIRD-PARTY-NOTICES.md) and keeps it only when its
// sha256 matches the pin in scripts/ip2region.sha256; the server reads <cwd>/data/ip2region_v4.xdb
// (apps/server/src/core/paths.ts) and leaves IP locations empty without it. Node stdlib only.
//
// Usage: node scripts/fetch-ip2region.mjs [--out <dir | file.xdb>] [--url <mirror>]
//        node scripts/fetch-ip2region.mjs --pin [--confirm <sha256>] [--out …] [--url …]
//   --out      target directory (file ip2region_v4.xdb) or a path ending in .xdb; default apps/server/data/
//   --url      another source of the same file (a mirror); the sha256 check still applies
//   --pin      the one-time reviewed pin (first use, or a deliberate upgrade after upstream changed the
//              data): alone it downloads, prints the sha256 and writes nothing; after review,
//              `--pin --confirm <that sha256>` writes the pin (and the file) only if the download still
//              has that hash. Commit scripts/ip2region.sha256 afterwards. Steps: docs/deploy.md.
// POSIX proxy: NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://host:port node scripts/fetch-ip2region.mjs
// PowerShell 5.1: $env:NODE_USE_ENV_PROXY='1'; $env:HTTPS_PROXY='http://host:port'
// Then: node scripts/fetch-ip2region.mjs; check $LASTEXITCODE; remove the two Env: variables afterwards.
// Full proxy/cleanup example: docs/deploy.md, Windows section.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const SOURCE =
  'https://raw.githubusercontent.com/lionsoul2014/ip2region/master/data/ip2region_v4.xdb'
const root = fileURLToPath(new URL('..', import.meta.url))
const PIN = join(root, 'scripts/ip2region.sha256')
const SHA256 = /^[0-9a-f]{64}$/

/** Why the run stops before downloading anything, or null. */
export function refusal({ pinned, pin, confirm }) {
  if (confirm !== undefined && !pin) return '--confirm only goes with --pin'
  if (confirm !== undefined && !SHA256.test(confirm))
    return '--confirm takes the 64 hex digit sha256 that --pin printed'
  if (pinned || pin) return null
  return [
    'no sha256 pinned in scripts/ip2region.sha256 yet, so nothing can be checked. One-time reviewed pin',
    '(docs/deploy.md):',
    '  1. node scripts/fetch-ip2region.mjs --pin              downloads, prints the sha256, writes nothing',
    '  2. review: the source is github.com/lionsoul2014/ip2region (licence Apache-2.0 OR MIT, used under',
    '     MIT: THIRD-PARTY-NOTICES.md) and the hash matches a second download or the upstream commit',
    '  3. node scripts/fetch-ip2region.mjs --pin --confirm <sha256>   writes the pin and the file',
    '  4. commit scripts/ip2region.sha256; later runs (and image builds) check against it',
  ].join('\n')
}

/**
 * What a download of `sha256` leads to: `keep` the file, write the `pin`, the exit code and message.
 * Only a pinned hash, or with --pin the hash the operator confirmed after review, is ever kept.
 */
export function verdict({ pinned, pin, confirm, sha256, bytes }) {
  if (pin && confirm === undefined)
    return {
      keep: false,
      pin: false,
      exit: 1,
      message: `downloaded ${bytes} bytes, sha256 ${sha256}; nothing written. Review it (docs/deploy.md), then: node scripts/fetch-ip2region.mjs --pin --confirm ${sha256}`,
    }
  if (pin && confirm !== sha256)
    return {
      keep: false,
      pin: false,
      exit: 1,
      message: `sha256 mismatch: got ${sha256}, confirmed ${confirm}; nothing written (the source changed since the review?)`,
    }
  if (pin) return { keep: true, pin: true, exit: 0, message: `pinned ${sha256} in ${PIN}` }
  if (sha256 !== pinned)
    return {
      keep: false,
      pin: false,
      exit: 1,
      message: `sha256 mismatch: got ${sha256}, pinned ${pinned}; nothing written (upstream data changed? re-pin with --pin after review)`,
    }
  return { keep: true, pin: false, exit: 0, message: `sha256 ${sha256} matches the pin` }
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      url: { type: 'string' },
      pin: { type: 'boolean' },
      confirm: { type: 'string' },
    },
  })
  const outArg = resolve(values.out ?? join(root, 'apps/server/data'))
  const out = outArg.endsWith('.xdb') ? outArg : join(outArg, 'ip2region_v4.xdb')
  const url = values.url ?? SOURCE
  const fail = (msg) => {
    console.error(`fetch-ip2region: ${msg}`)
    process.exit(1)
  }

  const pinned = existsSync(PIN) ? readFileSync(PIN, 'utf8').trim() : ''
  const args = { pinned, pin: values.pin === true, confirm: values.confirm?.toLowerCase() }
  const refused = refusal(args)
  if (refused) fail(refused)

  console.log(`fetch-ip2region: ${url}`)
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) }).catch((e) =>
    fail(`download failed: ${e.cause?.code ?? e.message}`),
  )
  if (!res.ok) fail(`download failed: HTTP ${res.status}`)
  const data = Buffer.from(await res.arrayBuffer())
  const sha256 = createHash('sha256').update(data).digest('hex')

  const v = verdict({ ...args, sha256, bytes: data.length })
  if (!v.keep) fail(v.message)
  if (v.pin) writeFileSync(PIN, `${sha256}\n`)
  console.log(`fetch-ip2region: ${v.message}`)
  mkdirSync(dirname(out), { recursive: true })
  // rename: a reader never sees a half-written file
  writeFileSync(`${out}.part`, data)
  renameSync(`${out}.part`, out)
  console.log(`fetch-ip2region: ${out} (${data.length} bytes, sha256 ${sha256})`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
