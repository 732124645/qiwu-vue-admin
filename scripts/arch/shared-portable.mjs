// packages/shared also runs in the uni-app client (Vue 3.4, mini-program JS engines), so its
// source imports only zod and its own files (no Node API, no Vue), and its tsconfig keeps `"types": []`
// so the typecheck rejects Node globals (process, Buffer, __dirname, …). Specs are exempt.
import { importsOf } from './web-deps.mjs'

// 浏览器媒体仅由独立子入口加载；端内引擎的哈希/UTF-8 依赖为无平台全局的纯 JS。
const allowed = {
  'packages/shared/src/platform/im/client/engine.ts': ['@noble/hashes/sha256', '@stablelib/utf8'],
  'packages/shared/src/platform/im/media/browser.ts': ['livekit-client'],
  'packages/shared/src/platform/im/media/voice.ts': [
    'recorder-core',
    'recorder-core/src/engine/wav.js',
  ],
}

export const help = {
  fix: 'packages/shared imports only zod and its own files and keeps "types": [] in its tsconfig: move Node or Vue code to apps/server or apps/web.',
  doc: 'docs/design-notes.md#layering',
}

export default function ({ files, read }) {
  const out = []
  const types = JSON.parse(read('packages/shared/tsconfig.json')).compilerOptions?.types
  if (!Array.isArray(types) || types.length)
    out.push(
      'packages/shared/tsconfig.json: keep "types": [] (no Node globals in shared: the uni-app client builds it too)',
    )
  const sharedFiles = files('packages/shared/src/**/*.ts')
  for (const file of sharedFiles) {
    if (file.endsWith('.spec.ts')) continue
    for (const spec of importsOf(read(file)))
      if (spec !== 'zod' && !spec.startsWith('.') && !allowed[file]?.includes(spec))
        out.push(
          `${file}: imports '${spec}'; shared may import only zod and its own files (the uni-app client builds it too)`,
        )
  }
  for (const file of ['packages/shared/src/index.ts', 'packages/shared/src/im-client.ts']) {
    if (!sharedFiles.includes(file)) continue
    for (const spec of importsOf(read(file)))
      if (/(?:im-media|\/media\/(?!types\.js$))/.test(spec))
        out.push(`${file}: browser media must stay behind the im-media subpath`)
  }
  return out
}
