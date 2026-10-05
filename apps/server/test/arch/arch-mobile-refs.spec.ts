// scripts/arch/mobile-refs.mjs and shared-portable.mjs against a throwaway tree: a reference to the
// repo-root mobile/ outside it fails unless it is a whitelisted line; comments, the API route 'mobile/code'
// and the phone field `mobile` pass. Shared may import only zod and its own files and keeps "types": [].
// The real tree passing is `pnpm arch:check` (pnpm verify).
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const TREE: Record<string, string> = {
  'apps/web/src/a.ts': "import { t } from '../../../mobile/src/core/i18n'\n",
  'apps/web/src/b.ts': [
    '// the client lives in mobile/src (a comment)',
    "const user = { mobile: '13800000000' }",
    'api.post(`${BASE}/mobile/code`, user)',
    "@Post('mobile/code') send() {}",
    '',
  ].join('\n'),
  'apps/web/tsconfig.json': '{ "references": [{ "path": "../../mobile" }] }\n',
  'scripts/tool.mjs': "const dir = join(root, 'mobile/src')\n",
  'scripts/i18n-check.mjs': "const MOBILE = 'mobile/src/'\nconst more = 'mobile/src/locales'\n",
  // the code generator's withMobile output: its one constant each, nothing more
  'scripts/gen-check-golden.mjs': "const MOBILE = 'mobile/src/'\nconst api = 'mobile/src/api'\n",
  'apps/server/src/modules/platform/codegen/workspace.ts':
    "export const MOBILE = 'mobile/src/'\nconst pages = 'mobile/src/pages.json'\n",
  'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - mobile\n',
  'package.json': [
    '{',
    '  "scripts": {',
    '    "mobile:test": "pnpm -C mobile test",',
    '    "all": "pnpm -C mobile build:h5 && pnpm -r build"',
    '  }',
    '}',
    '',
  ].join('\n'),
  '.prettierignore': 'dist/\nmobile/\n',
  '.oxlintrc.json': '{ "ignorePatterns": ["mobile/src/**"] }\n',
  'packages/shared/tsconfig.json': '{ "compilerOptions": { "types": ["node"] } }\n',
  'packages/shared/src/a.ts': [
    "import { z } from 'zod'",
    "import { b } from './b.js'",
    "import { readFileSync } from 'node:fs'",
    "export { ref } from 'vue'",
    '',
  ].join('\n'),
  'packages/shared/src/a.spec.ts': "import { it } from 'vitest'\n",
}

it.each(['native', 'windows'])(
  '%s: flags references to mobile/ outside the whitelist and non-portable shared code',
  (platform) => {
    const root = mkdtempSync(join(tmpdir(), 'qw-arch-'))
    try {
      for (const [file, text] of Object.entries(TREE)) {
        mkdirSync(dirname(join(root, file)), { recursive: true })
        writeFileSync(join(root, file), text)
      }
      const r = spawnSync(
        process.execPath,
        [
          ...(platform === 'windows' ? ['--import', './test/arch/fixtures/windows-paths.mjs'] : []),
          '../../scripts/arch/run.mjs',
          '--root',
          root,
          '--only',
          'mobile-refs,shared-portable',
        ],
        { encoding: 'utf8' },
      )
      expect(r.status).toBe(1)
      const found = [...r.stderr.matchAll(/ {2}x (\S+?):? (?:references|imports|keep)/g)]
        .map(([, v]) => v)
        .sort()
      expect(found).toEqual([
        '.oxlintrc.json:1',
        'apps/server/src/modules/platform/codegen/workspace.ts:2',
        'apps/web/src/a.ts:1',
        'apps/web/tsconfig.json:1',
        'package.json:4',
        'packages/shared/src/a.ts',
        'packages/shared/src/a.ts',
        'packages/shared/tsconfig.json',
        'pnpm-workspace.yaml:3',
        'scripts/gen-check-golden.mjs:2',
        'scripts/i18n-check.mjs:2',
        'scripts/tool.mjs:1',
      ])
      expect(r.stderr).toContain("imports 'node:fs'")
      expect(r.stderr).toContain("imports 'vue'")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)
