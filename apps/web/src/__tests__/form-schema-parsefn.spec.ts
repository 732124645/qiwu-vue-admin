import { describe, expect, it } from 'vitest'
import formCreate from '@form-create/element-ui'
import { isCodeString, sanitizeFormSchema } from '@qiwu/shared'

// docs/adr/004-form-create.md: every string form-create's own parser turns into a function (`parseFn`, run on every
// value by `parseJson`; `new Function` under the hood, which the SPA CSP blocks) is one the sanitizer rejects.
const compiled = [
  '$FN:function(){return 1}',
  '$FN:() => 1',
  '$FNX:return 1',
  '$EXEC:function(){return 1}',
  '$GLOBAL:submit',
  '[[FORM-CREATE-PREFIX-function(){return 1}-FORM-CREATE-SUFFIX]]',
  'function () { return 1 }',
  'function(){return 1}',
  'function named() { return 1 }',
]
// parseFn trims first: every character String#trim strips
const blanks = Array.from({ length: 0x10000 }, (_, c) => String.fromCharCode(c)).filter(
  (c) => (c + 'x').trim() === 'x',
)

describe('sanitizeFormSchema vs form-create parseFn', () => {
  it('knows every leading blank parseFn trims', () => expect(blanks.length).toBeGreaterThan(20))

  it.each(compiled)('rejects %j behind any trimmed blank', (body) => {
    const all = [body, ...blanks.map((c) => c + body), `${blanks.join('')}${body}\n`]
    // the corpus really compiles, so the sanitizer has to catch each one
    expect(all.filter((s) => typeof formCreate.parseFn(s) !== 'function')).toEqual([])
    expect(all.filter((s) => !isCodeString(s))).toEqual([])
    const kept = all.filter((s) => {
      const r = sanitizeFormSchema({ rule: [{ type: 'input', field: 'x', title: s }] })
      return r.ok || r.errors[0]?.code !== 'code'
    })
    expect(kept).toEqual([])
  })

  it('keeps near misses, which parseJson leaves as text', () => {
    const r = sanitizeFormSchema({
      rule: [{ type: 'input', field: 'a', title: 'functional', info: '$100', value: 'FN: x' }],
    })
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    // a value parseJson compiled would be a function, which JSON.stringify drops
    expect(JSON.stringify(formCreate.parseJson(JSON.stringify(r.schema)))).toBe(
      JSON.stringify(r.schema),
    )
  })
})
