// Writing generated files ("写入工作区"; see docs/design-notes.md#codegen): into the repository only with
// NODE_ENV=development && CODEGEN_WRITE=true, only below the whitelisted source roots, never over an
// existing file (a changed one is shown as a diff instead), never through a symlink; `render --out`
// writes a copy anywhere outside the repository; the page's download zips them. Paths come from checked
// identifiers, but are checked again here: this is the last step before the disk or the wire.
import { spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { ZipArchive } from 'archiver'
import type { RenderedFile } from './render.js'

/**
 * The uni-app client's sources: a `withMobile` config's pages go there. PC only (no
 * `mobile/`, docs/mobile.md): nothing is rendered there, so this line stays harmless.
 */
export const MOBILE = 'mobile/src/'

/**
 * The repository has the mobile client (`renderCrud` renders a `withMobile` config's pages only then).
 * Never throws: previews also run where `repoRoot` would throw (a deployed server).
 */
export const hasMobile = (cwd = process.cwd()): boolean =>
  existsSync(resolve(cwd, '../..', MOBILE, 'pages.json'))

/** Where generated files may go in the repository (see docs/design-notes.md#codegen). */
const WRITABLE = [
  /^apps\/[a-z][a-z0-9-]*\/src\//,
  /^packages\/shared\/src\//,
  /^apps\/server\/test\//,
  new RegExp(`^${MOBILE}`),
]
/** A plain repository-relative path: no absolute path, `.`/`..`/empty segment, backslash or odd char. */
const PLAIN = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/

export class WorkspaceError extends Error {}

/** Workspace writes are on: the dev env (`.env`) sets both. */
export const canWrite = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.NODE_ENV === 'development' && env.CODEGEN_WRITE === 'true'

/** The repository root: two levels above the server package (every runtime path is from cwd). */
export function repoRoot(cwd = process.cwd()): string {
  const root = resolve(cwd, '../..')
  if (!existsSync(join(root, 'pnpm-workspace.yaml')))
    throw new WorkspaceError(`not the repository root (run in apps/server): ${root}`)
  return realpathSync(root)
}

/** A plain relative path, optionally one of the whitelisted source roots; else a WorkspaceError. */
export function checkPath(path: string, whitelist: boolean): string {
  if (!PLAIN.test(path)) throw new WorkspaceError(`refused path: ${JSON.stringify(path)}`)
  if (whitelist && !WRITABLE.some((re) => re.test(path)))
    throw new WorkspaceError(`not a writable source path: ${path}`)
  return path
}

/**
 * Every path once: two tables of one batch that map to the same module (same group, domain and business)
 * would otherwise write one over the other.
 */
function assertDistinct(files: RenderedFile[]): void {
  const seen = new Set<string>()
  for (const { path } of files) {
    if (seen.has(path))
      throw new WorkspaceError(
        `two files of this batch go to ${path} (tables with the same group, domain and business?); nothing was written`,
      )
    seen.add(path)
  }
}

/**
 * `path` below `root` with no symlink on the way (an existing component that is one is refused), every
 * existing parent a directory and the file itself not one: checked for the whole batch before a write.
 */
export function target(root: string, path: string): string {
  let at = root
  const parts = path.split('/')
  for (const [i, part] of parts.entries()) {
    at = join(at, part)
    if (isLink(at)) throw new WorkspaceError(`refused path through a symlink: ${path}`)
    if (!existsSync(at)) break
    if (statSync(at).isDirectory() !== i < parts.length - 1)
      throw new WorkspaceError(
        `refused path (${relative(root, at).split(sep).join('/')} is in the way): ${path}`,
      )
  }
  const full = resolve(root, path)
  if (!full.startsWith(root + sep)) throw new WorkspaceError(`refused path: ${path}`)
  return full
}
const isLink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/** Git's unified hunks, with repository-relative headers; a plain notice when Git is absent. */
export function diffOf(file: string, path: string, content: string): string {
  if (readFileSync(file).equals(Buffer.from(content, 'utf8'))) return ''
  const dir = mkdtempSync(join(tmpdir(), 'qw-codegen-diff-'))
  try {
    const rendered = join(dir, 'rendered')
    writeFileSync(rendered, content, 'utf8')
    const r = spawnSync(
      'git',
      ['diff', '--no-index', '--no-color', '--no-ext-diff', '--', file, rendered],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    )
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT')
      return `${path}: differs (no Git to show how)\n`
    if (r.error || (r.status !== 0 && r.status !== 1))
      throw new WorkspaceError(`git diff ${path}: ${r.error?.message ?? r.stderr ?? r.status}`)
    const start = r.stdout.search(/^@@/m)
    return start < 0
      ? `${path}: differs (line endings/attributes only or no text hunk)\n`
      : `--- a/${path}\n+++ b/${path}\n${r.stdout.slice(start)}`
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export interface WriteResult {
  written: string[]
  /** already there with the same content */
  unchanged: string[]
  /** already there with other content: nothing was written at all */
  conflicts: { path: string; diff: string }[]
}

/**
 * Writes `files` into the repository at `root` (see docs/design-notes.md#codegen): whitelisted paths only, each once, no
 * symlinks, no overwrite. Existing identical files are left alone; if any existing file differs, nothing is written
 * and each difference comes back as a diff. `env` must allow it (`canWrite`). All or nothing: every
 * path is checked first, and a write that still fails (a file that appeared in between: `wx`, a
 * permission, a full disk) removes the files this batch created and then its new directories that are
 * empty (never another writer's file) before the error is thrown.
 * Checks then writes (no lock).
 */
export function writeWorkspace(
  root: string,
  files: RenderedFile[],
  env: NodeJS.ProcessEnv = process.env,
): WriteResult {
  if (!canWrite(env))
    throw new WorkspaceError('writing is off: needs NODE_ENV=development and CODEGEN_WRITE=true')
  assertDistinct(files)
  const result: WriteResult = { written: [], unchanged: [], conflicts: [] }
  const todo: [string, RenderedFile][] = []
  for (const f of files) {
    const full = target(root, checkPath(f.path, true))
    if (!existsSync(full)) todo.push([full, f])
    else if (readFileSync(full).equals(Buffer.from(f.content, 'utf8')))
      result.unchanged.push(f.path)
    else result.conflicts.push({ path: f.path, diff: diffOf(full, f.path, f.content) })
  }
  if (result.conflicts.length) return result
  const created: string[] = []
  const dirs: string[] = []
  try {
    for (const [full, f] of todo) {
      const first = mkdirSync(dirname(full), { recursive: true })
      // the directories it made: the file's and up to the first new one
      for (let d = dirname(full); first && d !== dirname(d); d = dirname(d)) {
        dirs.push(d)
        if (d === first) break
      }
      const fd = openSync(full, 'wx')
      created.push(full)
      try {
        writeFileSync(fd, f.content)
      } finally {
        closeSync(fd)
      }
      result.written.push(f.path)
    }
  } catch (err) {
    for (const p of created) rmSync(p, { force: true })
    for (const d of dirs.sort((a, b) => b.length - a.length))
      try {
        rmdirSync(d)
      } catch {
        // not empty: someone else's file is in it now
      }
    throw new WorkspaceError(`writing failed, nothing was kept: ${(err as Error).message}`)
  }
  return result
}

/**
 * `render --out <dir>`: a copy of the files below `dir` (created, files replaced), which must lie
 * outside the repository at `root`: the workspace is written only by `writeWorkspace`.
 */
export function writeCopy(root: string, dir: string, files: RenderedFile[]): string[] {
  const outside = (p: string) => {
    const rel = relative(root, p)
    return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
  }
  const refuse = (p: string) =>
    new WorkspaceError(`--out must be outside the repository (use write): ${p}`)
  const out = resolve(dir)
  if (!outside(out)) throw refuse(out)
  assertDistinct(files)
  mkdirSync(out, { recursive: true })
  // a symlink on the way may still lead back in
  const real = realpathSync(out)
  if (!outside(real)) throw refuse(real)
  for (const f of files) {
    const full = target(real, checkPath(f.path, false))
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, f.content)
  }
  return files.map((f) => join(real, f.path))
}

/** One date for every zip entry: the same files zip to the same bytes. */
const ZIP_DATE = new Date('2000-01-01T00:00:00Z')

/**
 * GET /download: `files` as one zip at their repository paths (whitelisted again, each once), streamed.
 * A failure after the response started can only abort it (the stream errors).
 */
export function zipOf(files: RenderedFile[]): Readable {
  assertDistinct(files)
  const zip = new ZipArchive({ zlib: { level: 9 } })
  for (const f of files) zip.append(f.content, { name: checkPath(f.path, true), date: ZIP_DATE })
  // errors also reach the stream, which ends the response
  zip.finalize().catch(() => undefined)
  return zip
}
