// scripts/fetch-ip2region.mjs (geo): without a committed pin it refuses
// before downloading and explains the one-time reviewed pin; `--pin` alone only prints the hash, and a
// pin is written only for the hash confirmed with `--confirm`. No network: the decisions are pure.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PATH = join(process.cwd(), '../../scripts/fetch-ip2region.mjs')
const { refusal, verdict } = (await import(pathToFileURL(PATH).href)) as {
  refusal: (a: { pinned: string; pin: boolean; confirm?: string }) => string | null
  verdict: (a: {
    pinned: string
    pin: boolean
    confirm?: string
    sha256: string
    bytes: number
  }) => { keep: boolean; pin: boolean; exit: number; message: string }
}

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

it('without a pin it refuses before any download and explains the reviewed pin procedure', () => {
  const msg = refusal({ pinned: '', pin: false })
  expect(msg).toMatch(/no sha256 pinned/)
  for (const step of [
    '--pin',
    '--confirm <sha256>',
    'THIRD-PARTY-NOTICES.md',
    'commit',
    'deploy.md',
  ])
    expect(msg).toContain(step)
  expect(refusal({ pinned: A, pin: false })).toBeNull()
  expect(refusal({ pinned: '', pin: true })).toBeNull()
  expect(refusal({ pinned: '', pin: true, confirm: A })).toBeNull()
})

it('--confirm needs --pin and a sha256', () => {
  expect(refusal({ pinned: A, pin: false, confirm: A })).toMatch(/only goes with --pin/)
  expect(refusal({ pinned: '', pin: true, confirm: 'abc' })).toMatch(/64 hex digit/)
})

it('--pin alone prints the hash and keeps nothing; a pin is written only for the confirmed hash', () => {
  const printed = verdict({ pinned: '', pin: true, sha256: A, bytes: 3 })
  expect(printed).toMatchObject({ keep: false, pin: false, exit: 1 })
  expect(printed.message).toContain(`--pin --confirm ${A}`)
  expect(verdict({ pinned: '', pin: true, confirm: B, sha256: A, bytes: 3 })).toMatchObject({
    keep: false,
    pin: false,
    exit: 1,
  })
  expect(verdict({ pinned: B, pin: true, confirm: A, sha256: A, bytes: 3 })).toMatchObject({
    keep: true,
    pin: true,
    exit: 0,
  })
})

it('a normal run keeps only the pinned hash', () => {
  expect(verdict({ pinned: A, pin: false, sha256: A, bytes: 3 })).toMatchObject({
    keep: true,
    pin: false,
  })
  const mismatch = verdict({ pinned: A, pin: false, sha256: B, bytes: 3 })
  expect(mismatch).toMatchObject({ keep: false, pin: false, exit: 1 })
  expect(mismatch.message).toMatch(/mismatch.*nothing written/)
})

it('the command itself refuses a bad flag set with exit 1 before any download', () => {
  const run = spawnSync(process.execPath, [PATH, '--confirm', A], { encoding: 'utf8' })
  expect(run.status).toBe(1)
  expect(run.stderr).toContain('--confirm only goes with --pin')
  expect(run.stdout).not.toContain('https://')
})
