// docs/design-notes.md#codegen: generator templates never print a value raw. `<%- %>` (unescaped output) is allowed only
// for `include(…)`; every other value goes through `<%= %>`, whose escape function (codegen/render.ts
// `emit`) prints only plain tokens and the helpers' output (str / json / comment) and throws on the rest.
// `<%%` is ejs's literal `<%` and not a tag.
const RAW = /<%(?!%)-([\s\S]*?)[-_]?%>/g
// the whole expression is one include of a literal path (no `include(…) + value`)
const WHITELIST = /^\s*include\(\s*(['"])[\w./-]+\1\s*\)\s*$/

export default function ({ files, read }) {
  const out = []
  for (const file of files('apps/server/codegen-templates/**/*.ejs')) {
    const src = read(file)
    for (const m of src.matchAll(RAW)) {
      if (WHITELIST.test(m[1])) continue
      const line = src.slice(0, m.index).split('\n').length
      out.push(
        `${file}:${line} <%- ${m[1].trim().slice(0, 40)} %> prints a value unescaped: use <%= %> with str()/json()/comment() (docs/design-notes.md#codegen)`,
      )
    }
  }
  return out
}
