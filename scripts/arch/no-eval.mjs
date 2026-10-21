// docs/design-notes.md#security: no dynamic code execution in app/package sources (oxlint no-eval is the first line;
// this also catches `Function('…')` and the `vm` module). Member calls like `redis.eval(` (Lua) are allowed.

export const help = {
  fix: 'Remove the dynamic code execution: parse data with JSON.parse or a lookup table of functions written in code instead of eval, new Function or the vm module.',
  doc: 'docs/design-notes.md#security',
}

const BAD = [
  [/(^|[^.\w$])eval\s*\(/, 'eval('],
  [/\bnew\s+Function\b/, 'new Function('],
  [/(^|[^.\w$])Function\s*\(\s*[`'"]/, 'Function(<string>)'],
  [/(\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](node:)?vm['"]/, "the 'vm' module"],
]

export default function ({ lines }) {
  const out = []
  for (const { file, n, line } of lines('{apps,packages}/*/src/**/*.{ts,vue}')) {
    const hit = BAD.find(([re]) => re.test(line))
    if (hit)
      out.push(
        `${file}:${n} ${hit[1]} is forbidden (arbitrary code execution; docs/design-notes.md#security)`,
      )
  }
  return out
}
