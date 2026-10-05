// Catch known Windows regressions; the real PowerShell 5.1 gate remains a manual check.
// Literal calls/paths only; dynamically constructed commands still need code review.
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const COMMAND = /^(?:pnpm|npm|npx)(?:\.cmd)?$/
const LAUNCH = /^(?:spawn|spawnSync|execFile|execFileSync)$/
const literal = (n) => n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))

export default function ({ root, files, read }) {
  const out = []
  const attrs = read('.gitattributes').split('\n')
  if (attrs[0] !== '* text=auto eol=lf')
    out.push('.gitattributes:1 must enforce * text=auto eol=lf')
  if (!attrs.includes('*.png binary')) out.push('.gitattributes: PNG assets must stay binary')
  for (const file of ['README.md', 'docs/getting-started.md']) {
    const text = existsSync(join(root, file)) ? read(file) : ''
    if (!/^#{1,6} .*Windows.*$/m.test(text) || !/^\s*```powershell\s*$/m.test(text))
      out.push(`${file}: must include a Windows section with a PowerShell example`)
  }
  if (existsSync(join(root, '.git'))) {
    const index = execFileSync('git', ['ls-files', '-s'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
    })
    // no tracked file may be a symlink: neither in the index nor swapped in on disk
    for (const line of index.split('\n')) {
      const [meta, file] = line.split('\t')
      if (!file) continue
      if (meta.startsWith('120000 ')) out.push(`${file}: tracked symlink is not portable`)
      else if (lstatSync(join(root, file), { throwIfNoEntry: false })?.isSymbolicLink())
        out.push(`${file}: must be a regular file, not a symlink`)
    }
  }

  for (const file of files('{scripts/**/*.mjs,apps/server/src/modules/platform/codegen/**/*.ts}')) {
    if (file === 'scripts/arch/windows-portable.mjs') continue
    const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true)
    const report = (n, message) =>
      out.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${message}`)
    const visit = (n) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === 'selfTest') return
      if (ts.isCallExpression(n)) {
        const name = ts.isPropertyAccessExpression(n.expression)
          ? n.expression.name.text
          : n.expression.getText(sf)
        const cmd = n.arguments[0]
        if (LAUNCH.test(name) && literal(cmd) && COMMAND.test(cmd.text))
          report(
            n,
            `literal ${name}(${cmd.text}) is not portable; use a Node bin or a fixed shell command`,
          )
      }
      if (literal(n)) {
        if (/(?:^|[\\/])\.bin[\\/](?:tsc|oxlint)(?:\.cmd)?$/.test(n.text))
          report(n, '.bin/tsc or .bin/oxlint must run through its Node bin')
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }

  // Only explicit Windows examples; POSIX tutorials keep their own shell syntax.
  for (const file of files('{docs/**/*.md,README.md}')) {
    let windows = false
    read(file)
      .split('\n')
      .forEach((line, i) => {
        if (/^\s*```/.test(line)) {
          windows = /^\s*```(?:powershell|ps1|pwsh|bat|cmd)\s*$/i.test(line)
          return
        }
        if (
          windows &&
          (/^\s*[A-Z_][A-Z\d_]*=\S+\s+\S/.test(line) || /&&|\||\/dev\/null|\\\s*$/.test(line))
        )
          out.push(`${file}:${i + 1} Windows example contains POSIX shell syntax`)
      })
  }
  return out
}
