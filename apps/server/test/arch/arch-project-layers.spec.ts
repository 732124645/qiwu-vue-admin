// scripts/arch/project-layers.mjs against a throwaway source tree: platform / workflow code
// (server, web, shared) importing a project domain directory or the server's project.module.ts fails,
// however the import is written; the open layers and page directories, other files right in a root and
// template texts pass. The real tree passing is `pnpm arch:check`.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const LISTS = 'packages/shared/src/common/reserved-names.ts'

it('flags every import of a project domain directory from platform and workflow code', () => {
  const root = mkdtempSync(join(tmpdir(), 'qw-arch-layers-'))
  const put = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  try {
    put(LISTS, readFileSync(join(process.cwd(), '../..', LISTS), 'utf8'))
    put(
      'apps/server/src/modules/platform/iam/a.service.ts',
      [
        "import { Leave } from '../../biz/leave/leave.entity.js'",
        "import type { Order } from '../../erp/order/order.entity.js'",
        "export * from '../../demo/x/x.js'",
        "import { ProjectModule } from '../../project.module.js'",
        "import { other } from '../../other.js'",
        "const lazy = () => import('../../erp/y.js')",
        "import { core } from '../../../core/x.js'",
        "import { wf } from '../../workflow/engine/e.js'",
        "import { z } from 'zod'",
        '// import { old } from "../../erp/old.js"',
        "const text = `import { a } from '../../${home}/a.js'`",
        "const loose = '../../erp/z.js'",
      ].join('\n'),
    )
    put(
      'apps/web/src/views/workflow/center/v.vue',
      [
        '<script setup lang="ts">',
        "import Leave from '@/views/biz/leave/view.vue'",
        "import Home from '@/views/home/index.vue'",
        "import { x } from '@/api/platform/iam'",
        "import { y } from '@/api/auth-extra'",
        "const all = import.meta.glob<unknown>('/src/views/**/*.vue')",
        '</script>',
      ].join('\n'),
    )
    put('apps/web/src/api/platform/p.ts', "import { e } from '../erp/order'\n")
    put(
      'packages/shared/src/workflow/w.ts',
      "import { b } from '../biz/leave.schema.js'\nimport { c } from '../common/crud.js'\n",
    )
    // not platform / workflow code: may import anything
    put('apps/server/src/modules/biz/x.ts', "import { o } from '../erp/order/order.js'\n")
    put('apps/web/src/core/router.ts', "const v = import.meta.glob('/src/views/**/*.vue')\n")
    const r = spawnSync(
      process.execPath,
      ['../../scripts/arch/run.mjs', '--root', root, '--only', 'project-layers'],
      { encoding: 'utf8' },
    )
    expect(r.status).toBe(1)
    expect(
      [...r.stderr.matchAll(/ x (\S+): imports '([^']+)'/g)].map(([, f, s]) => `${f} ${s}`),
    ).toEqual([
      'apps/server/src/modules/platform/iam/a.service.ts ../../biz/leave/leave.entity.js',
      'apps/server/src/modules/platform/iam/a.service.ts ../../erp/order/order.entity.js',
      'apps/server/src/modules/platform/iam/a.service.ts ../../demo/x/x.js',
      'apps/server/src/modules/platform/iam/a.service.ts ../../project.module.js',
      'apps/server/src/modules/platform/iam/a.service.ts ../../erp/y.js',
      'apps/web/src/api/platform/p.ts ../erp/order',
      'apps/web/src/views/workflow/center/v.vue @/views/biz/leave/view.vue',
      'apps/web/src/views/workflow/center/v.vue /src/views/**/*.vue',
      'packages/shared/src/workflow/w.ts ../biz/leave.schema.js',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
