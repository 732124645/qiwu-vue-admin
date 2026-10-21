// The AI-facing docs (the public rule files under public-ai/, docs/ai.md and docs/ai/**) are instructions a
// coding tool follows literally, so what they name must exist (see docs/ai/recipes/README.md#维护):
//  1. every `pnpm <script>` / `pnpm --filter <pkg> <script>` / `pnpm -C <dir> <script>` in inline code or a
//     fenced block is a script of that package.json (pnpm's own commands such as `pnpm i` pass);
//  2. every repo path in inline code (a word with a `/` whose first segment is an entry of the repository
//     root) and every relative link target exists;
//  3. a link to a markdown file with `#anchor` matches a heading of it (GitHub's slug: lowercase, punctuation
//     but `-` and `_` dropped, spaces to `-`, repeats `-1`, `-2`…) or an `<a id|name="…">`.
// The files under public-ai/ are exported to the same path without the `public-ai/` prefix, so their links
// resolve from that public place and every path may also be found under public-ai/. A path holding `<`, `*`
// or `{` is a placeholder and not checked; docs/ai/project-map.md is generated and skipped.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import { anchorsOf } from '../md-anchors.mjs'

export const help = {
  fix: 'Make the AI doc match the repository: name a script that exists in that package.json, a path that exists (written as its public path, without public-ai/), and a link whose heading exists; rename it here when the code was renamed.',
  doc: 'docs/ai/recipes/README.md#维护',
}

const PUBLIC = 'public-ai/'
// the agent rules file and the skills folder, spelled in parts (this script itself is public code)
const RULES = ['AGENTS', 'md'].join('.')
const SKILLS = `.${['clau', 'de'].join('')}/skills/`
const RULE_DIR = `.${['cur', 'sor'].join('')}/rules/`
const POINTER = `.github/${['copi', 'lot'].join('')}-instructions.md`
// the template's own exported skills and rule file; a project's other skills are not checked here
const OWN = /^qiwu[-.]/
const SKIP = new Set(['docs/ai/project-map.md'])
// a project's own rule file: the template names it but never ships it
const OPTIONAL = new Set(['docs/project-rules.md'])
// pnpm's own commands (not scripts); `run` names the script next
const BUILTIN = new Set(
  'i install add remove rm un uninstall up update upgrade exec dlx create init why ls list ll outdated audit licenses store rebuild rb prune fetch link ln unlink publish pack patch patch-commit env setup config root bin dedupe import deploy approve-builds self-update help'.split(
    ' ',
  ),
)
const VALUE_FLAGS = new Set(['--filter', '-F', '-C', '--dir'])
const PLACEHOLDER = /[<*{]/
// machine-local or built files: present on one machine, absent on a fresh clone
const LOCAL = /(^|\/)(\.env[\w.-]*|dist|node_modules|coverage)(\/|$)/
const PNPM = /(?:^|[\s;&|(])pnpm(?:\.cmd)?((?:\s+[^\s;&|)`]+)*)/g
const FENCE = /^\s*(```|~~~)/
const CODE = /`([^`\n]+)`/g
/** 解码链接里的百分号转义；写坏的转义按原文比较。 */
const decode = (s) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
const LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g

/** 拆出一条 pnpm 命令的目标：`--filter`/`-C` 的值、是否 `-r`、脚本名（`run` 之后的那个）。 */
export function parsePnpm(args) {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const cmd = { filters: [], dir: null, recursive: false, script: null, run: false }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const eq = /^(--filter|--dir)=(.*)$/.exec(t)
    const flag = eq?.[1] ?? (VALUE_FLAGS.has(t) ? t : null)
    if (flag) {
      const v = eq ? eq[2] : (tokens[++i] ?? '')
      if (flag === '-C' || flag === '--dir') cmd.dir = v
      else cmd.filters.push(v)
    } else if (t === '-r' || t === '--recursive') cmd.recursive = true
    else if (t.startsWith('-')) continue
    else if (t === 'run' && !cmd.run) cmd.run = true
    else {
      cmd.script = t
      break
    }
  }
  return cmd
}

export default function ({ root, files, read }) {
  const out = []
  const exists = (rel) => existsSync(join(root, rel))
  const isFile = (rel) => exists(rel) && statSync(join(root, rel)).isFile()
  // a path as written, or its public-ai/ source (the export moves public-ai/<x> to <x>)
  const found = (rel) => [rel, PUBLIC + rel].find((p) => exists(p))
  const rootEntries = new Set([
    ...readdirSync(root),
    ...(exists(PUBLIC) ? readdirSync(join(root, PUBLIC)) : []),
  ])

  const walk = (dir) =>
    exists(dir)
      ? readdirSync(join(root, dir), { recursive: true })
          .map((f) => `${dir}${String(f).split('\\').join('/')}`)
          .filter((f) => /\.mdc?$/.test(f) && isFile(f))
      : []
  // a public checkout has the exported files at the root instead of public-ai/ (the private repository's
  // own rule file is not one of them)
  const exported = exists(PUBLIC)
    ? walk(PUBLIC)
    : [
        ...[RULES, POINTER].filter(isFile),
        ...walk(SKILLS).filter((f) => OWN.test(f.slice(SKILLS.length))),
        ...walk(RULE_DIR).filter((f) => OWN.test(f.slice(RULE_DIR.length))),
      ]
  const docs = [...exported, ...(exists('docs/ai.md') ? ['docs/ai.md'] : []), ...walk('docs/ai/')]
    .filter((f) => !SKIP.has(f))
    .sort()

  // workspace packages: name and directory → directory
  const packages = new Map()
  for (const pkg of files('{apps,packages}/*/package.json')) {
    const dir = pkg.slice(0, -'/package.json'.length)
    packages.set(dir, dir)
    packages.set(JSON.parse(read(pkg)).name, dir)
  }
  const scriptsCache = new Map()
  const scriptsOf = (dir) => {
    if (!scriptsCache.has(dir)) {
      const pkg = dir === '.' ? 'package.json' : `${dir}/package.json`
      scriptsCache.set(dir, isFile(pkg) ? (JSON.parse(read(pkg)).scripts ?? {}) : null)
    }
    return scriptsCache.get(dir)
  }

  const anchorCache = new Map()
  const anchors = (rel) => {
    if (!anchorCache.has(rel)) anchorCache.set(rel, anchorsOf(read(rel)))
    return anchorCache.get(rel)
  }

  // parts a project may delete (docs/mobile.md#只要-pc删除移动端, the sample domains biz and demo):
  // once gone, the AI docs' mentions of them are not errors
  const gone = ['biz', 'demo'].filter((d) => !exists(`apps/server/src/modules/${d}`))
  const noMobile = !exists('mobile')
  const optional = (path) =>
    OPTIONAL.has(path) ||
    (noMobile && (path === 'docs/mobile.md' || path.split('/')[0] === 'mobile')) ||
    gone.some((d) => new RegExp(`(^|/)${d}([-./_]|$)`).test(path))
  // a script name, or a binary of an installed package (`pnpm vitest run`)
  const runs = (dir, name) =>
    scriptsOf(dir)?.[name] !== undefined ||
    [dir, '.'].some((d) => exists(`${d}/node_modules/.bin/${name}`))

  for (const file of docs) {
    // where the file lives in the public repository (its links are relative to that)
    const publicPath = file.startsWith(PUBLIC) ? file.slice(PUBLIC.length) : file
    const at = (n) => `${file}:${n}`

    const checkPnpm = (text, n) => {
      for (const [, args] of text.matchAll(PNPM)) {
        const cmd = parsePnpm(args)
        const { script } = cmd
        if (!script || [script, cmd.dir ?? '', ...cmd.filters].some((s) => PLACEHOLDER.test(s)))
          continue
        if (!cmd.run && BUILTIN.has(script)) continue
        if (noMobile && script.startsWith('mobile:')) continue
        const shown = `pnpm${args}`.trim()
        let dirs
        if (cmd.dir !== null) dirs = [cmd.dir.replace(/^\.\//, '').replace(/\/$/, '') || '.']
        else if (cmd.filters.length) {
          dirs = []
          for (const f of cmd.filters) {
            const dir = packages.get(
              f
                .replace(/^['"]|['"]$/g, '')
                .replace(/^\.\//, '')
                .replace(/\/$/, ''),
            )
            if (dir) dirs.push(dir)
            else
              out.push(
                `${at(n)} \`${shown}\`: no workspace package ${f}; name one of ${[...new Set(packages.values())].join(', ')} (by its package.json name or directory)`,
              )
          }
        } else if (cmd.recursive) {
          if (![...new Set(packages.values())].some((d) => scriptsOf(d)?.[script] !== undefined))
            out.push(
              `${at(n)} \`${shown}\`: no workspace package has a script "${script}"; fix the command or add the script`,
            )
          continue
        } else dirs = ['.']
        for (const dir of dirs) {
          const scripts = scriptsOf(dir)
          const where = dir === '.' ? 'package.json' : `${dir}/package.json`
          if (!scripts) out.push(`${at(n)} \`${shown}\`: ${where} does not exist`)
          else if (!runs(dir, script))
            out.push(
              `${at(n)} \`${shown}\`: ${where} has no script "${script}"; use one of its scripts (${Object.keys(scripts).join(', ')}) or add it`,
            )
        }
      }
    }

    const checkPath = (word, n) => {
      const path = word
        .replace(/^['"(]+|['",.;:)]+$/g, '')
        .replace(/#.*$/, '')
        .replace(/:\d+(?::\d+)?$/, '')
      if (!path.includes('/') || path.startsWith('/') || PLACEHOLDER.test(path)) return
      if (!rootEntries.has(path.split('/')[0]) || LOCAL.test(path)) return
      if (path.startsWith(PUBLIC)) {
        out.push(
          `${at(n)} ${path}: write the public path ${path.slice(PUBLIC.length)} (public-ai/ is the export source, not a path of the public repository)`,
        )
        return
      }
      if (!optional(path) && !found(path.replace(/\/$/, '')))
        out.push(`${at(n)} ${path} does not exist; correct the path or drop the mention`)
    }

    const checkLink = (target, n) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) return
      const hash = target.indexOf('#')
      const pathPart = decode(hash < 0 ? target : target.slice(0, hash))
      const anchor = hash < 0 ? null : decode(target.slice(hash + 1))
      let rel = file
      if (pathPart) {
        if (PLACEHOLDER.test(pathPart)) return
        const joined = posix.normalize(posix.join(posix.dirname(publicPath), pathPart))
        if (joined.startsWith('../')) {
          out.push(`${at(n)} link ${target} leaves the repository; link a file inside it`)
          return
        }
        if (optional(joined)) return
        rel = found(joined.replace(/\/$/, '') || '.')
        if (!rel) {
          out.push(
            `${at(n)} link ${target}: ${joined} does not exist; correct the link (relative to ${publicPath})`,
          )
          return
        }
      }
      if (anchor && /\.mdc?$/.test(rel) && isFile(rel) && !anchors(rel).has(anchor))
        out.push(
          `${at(n)} link ${target}: ${rel} has no heading #${anchor}; use the heading's slug (lowercase, punctuation dropped, spaces to -) or an <a id> in it`,
        )
    }

    let fenced = false
    read(file)
      .split('\n')
      .forEach((line, i) => {
        const n = i + 1
        if (FENCE.test(line)) {
          fenced = !fenced
          return
        }
        if (fenced) {
          checkPnpm(line, n)
          return
        }
        for (const [, code] of line.matchAll(CODE)) {
          checkPnpm(code, n)
          for (const word of code.split(/\s+/)) checkPath(word, n)
        }
        for (const [, target] of line.replace(CODE, '').matchAll(LINK)) checkLink(target, n)
      })
  }
  return out
}
