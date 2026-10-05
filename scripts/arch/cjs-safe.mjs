// docs/adr/001-module-format.md: the server must switch to CommonJS with zero source changes, so apps/server/src
// may not use `import.meta` or top-level await.
// Top-level await = `await` / `for await` / `[export] const|let|var x = await` /
// `export default await` starting at column 0. Prettier indents everything inside a function,
// so column 0 means module scope; an unformatted file could hide one (lint-staged runs prettier).
const TLA = /^(export\s+default\s+|(export\s+)?(const|let|var)\s+[^=]+=\s*)?(for\s+)?await\b/

export default function ({ lines }) {
  const out = []
  for (const { file, n, line } of lines('apps/server/src/**/*.ts')) {
    if (/\bimport\.meta\b/.test(line))
      out.push(
        `${file}:${n} import.meta breaks the CJS fallback (docs/adr/001-module-format.md); use src/core/paths.ts`,
      )
    else if (TLA.test(line))
      out.push(
        `${file}:${n} top-level await breaks the CJS fallback (docs/adr/001-module-format.md)`,
      )
  }
  return out
}
