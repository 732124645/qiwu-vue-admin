// Nothing outside mobile/ may depend on the uni-app client at the repo root, so PC-only
// users just delete mobile/ plus the whitelisted lines below (docs/mobile.md lists them; each one is also
// harmless once mobile/ is gone). Comment lines, docs/ and *.md are prose, not dependencies.
// A line heuristic over path-like tokens (`../mobile`, `'mobile/src'`, `mobile/**`, `-C mobile`,
// a workspace entry `- mobile`), so the API route `'mobile/code'` and the phone field `mobile` pass; a path
// built from parts (`join(root, 'mobile', 'src')`) slips through.
import { statSync } from 'node:fs'
import { join } from 'node:path'

export const REF = new RegExp(
  [
    String.raw`(?:\.\.\/)+mobile\b`,
    String.raw`(?:^|[\s'"\x60(=,[])mobile\/(?:src|e2e|scripts|dist|node_modules|package\.json|pnpm-|tsconfig|vite\.config|playwright\.config|license-exceptions|index\.html|\*|['"\x60\s]|$)`,
    String.raw`-C mobile\b`,
    String.raw`^\s*-\s*['"]?(?:\.\/)?mobile\b`,
  ].join('|'),
)

// file → the only kind of line in it that may reference mobile/
const ALLOW = {
  'package.json': /^\s*"mobile:[\w:-]+": "pnpm -C mobile [\w: -]+",?$/,
  '.oxlintrc.json': /"mobile\/\*\*"/,
  '.prettierignore': /^mobile\/$/,
  'eslint.config.mjs': /^\s*'mobile\/\*\*',$/,
  'scripts/ci-local.mjs': /^const MOBILE = /,
  'scripts/i18n-check.mjs': /^const MOBILE = /,
  'scripts/license-check.mjs': /^const MOBILE = /,
  'scripts/originality-check.mjs': /^const MOBILE = /,
  // the code generator's withMobile output: the one path constant each, paths built from it
  'scripts/gen-check-golden.mjs': /^const MOBILE = /,
  'apps/server/src/modules/platform/codegen/workspace.ts': /^export const MOBILE = /,
  // this check and its test
  'scripts/arch/mobile-refs.mjs': /./,
  'apps/server/test/arch/arch-mobile-refs.spec.ts': /./,
}

const PATTERNS = [
  '{apps,packages,scripts}/**/*.{ts,mts,cts,js,mjs,cjs,vue,json,yaml,yml,ejs,html,css,scss}',
  '*.{json,yaml,yml,js,mjs,cjs,ts}',
  '.*',
  '.husky/*',
]
const SKIP = /(^|\/)(dist|coverage)\/|^pnpm-lock\.yaml$|^\.git$/
const COMMENT = /^\s*(\/\/|\/\*|\*|#)/

export default function ({ root, files, read }) {
  const out = []
  for (const file of new Set(PATTERNS.flatMap(files))) {
    if (SKIP.test(file) || !statSync(join(root, file)).isFile()) continue
    read(file)
      .split('\n')
      .forEach((line, i) => {
        if (COMMENT.test(line) || !REF.test(line) || ALLOW[file]?.test(line)) return
        out.push(`${file}:${i + 1} references mobile/ (only the lines docs/mobile.md lists may)`)
      })
  }
  return out
}
