// packages/shared also runs in the uni-app client (Vue 3.4, mini-program JS engines), so its
// source imports only zod and its own files (no Node API, no Vue), and its tsconfig keeps `"types": []`
// so the typecheck rejects Node globals (process, Buffer, __dirname, …). Specs are exempt.
import { importsOf } from './web-deps.mjs'

export default function ({ files, read }) {
  const out = []
  const types = JSON.parse(read('packages/shared/tsconfig.json')).compilerOptions?.types
  if (!Array.isArray(types) || types.length)
    out.push(
      'packages/shared/tsconfig.json: keep "types": [] (no Node globals in shared: the uni-app client builds it too)',
    )
  for (const file of files('packages/shared/src/**/*.ts')) {
    if (file.endsWith('.spec.ts')) continue
    for (const spec of importsOf(read(file)))
      if (spec !== 'zod' && !spec.startsWith('.'))
        out.push(
          `${file}: imports '${spec}'; shared may import only zod and its own files (the uni-app client builds it too)`,
        )
  }
  return out
}
