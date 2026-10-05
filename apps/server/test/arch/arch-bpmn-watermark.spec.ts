// scripts/arch/bpmn-watermark.mjs against a throwaway tree: the web app may not target the bpmn.io
// watermark (its class, an a/img under .bjs-container, a bpmn.io attribute selector, `powered` in the BPMN
// views' styles, bpmn-embedded.css); comments, other diagram classes, `powered` outside styles or outside
// the BPMN views, and the Playwright specs under apps/web/e2e (they assert the logo) pass.
// The real tree passing is `pnpm arch:check`.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const V = 'apps/web/src/views/workflow/bpmn'
const TREE: Record<string, string> = {
  'apps/web/src/styles/a.css': [
    '/* never style .bjs-powered-by */',
    '.bjs-powered-by { opacity: 0 }',
    '.bjs-container a { display: none }',
    '.bjs-container > img { width: 0 }',
    '.bjs-container .djs-palette { left: 8px }',
    '.qw-canvas [href*="bpmn.io"] { visibility: hidden }',
    '.bjs-container { height: 100% }',
    '',
  ].join('\n'),
  [`${V}/WfBpmnDesigner.vue`]: [
    '<template><div class="qw-bpmn" title="powered" /></template>',
    '<script setup lang="ts">',
    "import 'bpmn-js/dist/assets/bpmn-font/css/bpmn-embedded.css'",
    "import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css'",
    "const poweredNote = 'x'",
    '</script>',
    '<style scoped>',
    '.qw-bpmn :deep(.bjs-container) :deep(a) { color: red }',
    '.qw-bpmn .powered { z-index: 1 }',
    '.qw-logo-plate { z-index: 99 }',
    '</style>',
    '',
  ].join('\n'),
  [`${V}/bpmn.css`]: '.x[class*="Powered"] { color: red }\n',
  'apps/web/src/views/other/b.vue': '<style>\n.powered { color: red }\n</style>\n',
  'apps/web/src/core/c.ts': [
    "document.querySelector('.bjs-container a')",
    "const el = document.querySelector('.bjs-container')",
    '// see .bjs-powered-by',
    '',
  ].join('\n'),
  'apps/web/e2e/wf-bpmn-canvas.spec.ts': "const logo = page.locator('.bjs-powered-by')\n",
  'apps/web/e2e/wf-bpmn-flow.spec.ts':
    "await expect(page.locator('.bjs-powered-by')).toBeVisible()\n",
}

it('flags web code that targets the bpmn.io watermark', () => {
  const root = mkdtempSync(join(tmpdir(), 'qw-arch-'))
  try {
    for (const [file, text] of Object.entries(TREE)) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), text)
    }
    const r = spawnSync(
      process.execPath,
      ['../../scripts/arch/run.mjs', '--root', root, '--only', 'bpmn-watermark'],
      { encoding: 'utf8' },
    )
    expect(r.status).toBe(1)
    const found = [...r.stderr.matchAll(/ {2}x (\S+)/g)].map(([, v]) => v).sort()
    expect(found).toEqual([
      'apps/web/src/core/c.ts:1',
      'apps/web/src/styles/a.css:2',
      'apps/web/src/styles/a.css:3',
      'apps/web/src/styles/a.css:4',
      'apps/web/src/styles/a.css:6',
      `${V}/WfBpmnDesigner.vue:3`,
      `${V}/WfBpmnDesigner.vue:8`,
      `${V}/WfBpmnDesigner.vue:9`,
      `${V}/bpmn.css:1`,
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
