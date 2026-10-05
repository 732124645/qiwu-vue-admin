// docs/adr/004-form-create.md, docs/design-notes.md#security: what `vite build` put into apps/web/dist (the source guards never see bundled
// dependency code). Run after a build: `pnpm --filter @qiwu/web build && node scripts/arch/run.mjs --only web-bundle`.
// 1. No wangeditor v4: @form-create/designer's dist entry inlines it (the vite alias builds the designer
//    from src, with a stub). Matched by v4-only config keys, which minifiers keep: @wangeditor-next
//    (<RichEditor>) has none of them, but does print `wangEditor`.
// 2. No eval / Function(<code>) call outside ALLOW (the SPA CSP has no 'unsafe-eval': they throw when reached).
// Without a dist the full run skips it (`pnpm verify` runs before the build); `--only web-bundle` fails.
// Self-test: node scripts/arch/web-bundle.mjs --self-test
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = 'apps/web/dist'
const WANGEDITOR_V4 =
  /\b(uploadImgServer|uploadImgShowBase64|uploadImgMaxSize|pasteFilterStyle|onchangeTimeout|zIndexFullScreen)\b/
// minifiers print `new Function(` as `Function(`; not `x.Function(` (form-create `is.Function(v)`),
// not `Function(?` (regex source inside shiki grammars)
const CODE = /(?<![\w$.])(eval|Function)\((?!\?)/g
/** [pattern on the text from the hit on, why it cannot run attacker text] */
// Matched on minified text, so an upgrade that reshapes these lines fails here: re-check, then adjust
const ALLOW = [
  [/^Function\([\w$,]*\)\{/, 'a method named Function (form-create `is.Function(v) {…}`), no call'],
  [
    /^Function\((["'`])return this\1\)\(\)/,
    'global-object fallback (lodash, …): self/window win first',
  ],
  [
    /^Function\((["'`])\1\),!0\}catch/,
    "zod's eval probe: false under the CSP, so zod stays jitless",
  ],
  [
    /^Function\((["'`])return \1\+[\w$]+\)\(\)/,
    'form-create parseFn + designer Struct editors: sanitizeFormSchema rejects every string parseFn compiles, the editors are hidden',
  ],
  [
    /^Function\((["'`])return function \(\1\+this\.argStr\+/,
    'designer FnEditor (event / function props editors): hidden',
  ],
  [
    /^Function\(\.\.\.[\w$]+,[\w$]+\)/,
    'form-create compileFn (computed / control rules): sanitizeFormSchema rejects those keys',
  ],
]

/** Violations in one bundled file. */
export function scan(file, text) {
  const out = []
  const v4 = text.match(WANGEDITOR_V4)
  if (v4)
    out.push(
      `${file}: wangeditor v4 code ('${v4[1]}'); import the designer by its bare name only (docs/adr/004-form-create.md)`,
    )
  for (const m of text.matchAll(CODE)) {
    const at = text.slice(m.index, m.index + 80)
    if (!ALLOW.some(([re]) => re.test(at)))
      out.push(`${file}: ${m[1]}() call '${at.slice(0, 60)}' (SPA CSP has no 'unsafe-eval')`)
  }
  return out
}

export default function check({ root, files, read, only }) {
  if (!existsSync(join(root, DIST, 'index.html'))) {
    if (only?.includes('web-bundle'))
      return [`${DIST} missing: pnpm --filter @qiwu/web build first`]
    console.log(`  skipped: no ${DIST} (checked after the build: ci:local)`)
    return []
  }
  return files(`${DIST}/**/*.js`).flatMap((f) => scan(f, read(f)))
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--self-test')) {
  // as the build prints them (apps/web/dist, 2026-10)
  const ok = [
    'var a=1;export{a}',
    '},Function(e){let t=this.getType(e);return t===`Function`}',
    'S=le||ue||Function(`return this`)(),C=S.Symbol',
    'try{return Function(``),!0}catch{return!1}',
    'function Xr(e){return Function(`return `+e)()}',
    'r||(zf.size>=Bf&&zf.clear(),r=Function(...e,t),zf.set(n,r)),r',
    'try{t=Function(`return function (`+this.argStr+`){\n`+e+`\n}`)()}catch(e){}',
    '(?<!\\\\.))Function(?![$_[:alnum:]])',
    'Vr.Function(e)&&redis.eval(x)',
    // @wangeditor-next 6
    'console.error(`wangEditor upload file - onSuccess error`,e);fieldName:`wangeditor-uploaded-image`',
  ]
  for (const text of ok) assert.deepEqual(scan('a.js', text), [], text)
  const bad = [
    ['{uploadImgServer:``,uploadImgShowBase64:!1}', /wangeditor v4 code \('uploadImgServer'\)/],
    ['e.pasteFilterStyle=!0', /wangeditor v4/],
    ['eval(x)', /eval\(\) call 'eval\(x\)'/],
    ['(0,x)=eval(`1`)', /eval\(\) call/],
    ['Function("alert(1)")()', /Function\(\) call/],
    ['new Function("a","return a")', /Function\(\) call/],
    ['Function(`return `+e+`;`)()', /Function\(\) call/],
    ['Function(`return this.x`)()', /Function\(\) call/],
  ]
  for (const [text, re] of bad) {
    const v = scan('a.js', text)
    assert.equal(v.length, 1, text)
    assert.match(v[0], re)
  }
  const none = { root: '/nonexistent', files: () => assert.fail('no dist: no scan') }
  assert.deepEqual(check(none), [])
  assert.match(check({ ...none, only: ['web-bundle'] })[0], /apps\/web\/dist missing/)
  console.log('web-bundle self-test ok')
}
