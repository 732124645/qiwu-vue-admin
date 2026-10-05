// scripts/arch/reserved-names.mjs against a throwaway source tree: a template controller
// root, locale namespace, top-level code directory or static web route (whole or first segment) missing
// from the reserved names fails, as does WEB_STATIC_ROUTE_NAMES not listing the router's static routes; a
// project domain's (a non-reserved top-level modules/ directory) pass. The real tree passing is `pnpm arch:check`.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PROJECT_BUILTIN_DOMAINS, RESERVED_NAMES, WEB_STATIC_ROUTE_NAMES } from '@qiwu/shared'

const LISTS = 'packages/shared/src/common/reserved-names.ts'
const REPO = join(process.cwd(), '../..')

it('reserves im: a project config cannot take it', () => {
  expect(RESERVED_NAMES.has('im')).toBe(true)
  expect(PROJECT_BUILTIN_DOMAINS).not.toContain('im')
})

it('reads the same names as @qiwu/shared', async () => {
  const { reservedLists } = (await import(
    pathToFileURL(join(REPO, 'scripts/arch/reserved-names.mjs')).href
  )) as { reservedLists: (text: string) => Record<string, string[]> }
  const parsed = Object.values(reservedLists(readFileSync(join(REPO, LISTS), 'utf8'))).flat()
  expect(new Set(parsed)).toEqual(RESERVED_NAMES)
})

it('reads the static routes of the router and WEB_STATIC_ROUTE_NAMES', async () => {
  const { staticRouteNames, listedRouteNames } = (await import(
    pathToFileURL(join(REPO, 'scripts/arch/reserved-names.mjs')).href
  )) as Record<'staticRouteNames' | 'listedRouteNames', (text: string) => string[]>
  const router = readFileSync(join(REPO, 'apps/web/src/core/router/index.ts'), 'utf8')
  expect(staticRouteNames(router)).toEqual(expect.arrayContaining(['layout', 'my-inbox', '404']))
  expect(listedRouteNames(readFileSync(join(REPO, LISTS), 'utf8'))).toEqual(WEB_STATIC_ROUTE_NAMES)
})

it('flags controller roots, locale namespaces and code directories that are not reserved', () => {
  const root = mkdtempSync(join(tmpdir(), 'qw-arch-reserved-'))
  const put = (path: string, content = '') => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  const controller = (path: string) => `@Controller('${path}')\nexport class X {}\n`
  try {
    put(LISTS, readFileSync(join(REPO, LISTS), 'utf8'))
    put('apps/server/src/modules/platform/iam/a.controller.ts', controller('iam/a'))
    put('apps/server/src/modules/platform/foo/b.controller.ts', controller('foo/b'))
    // a template controller never takes a project domain's root
    put('apps/server/src/modules/platform/geo/c.controller.ts', controller('erp/c'))
    put('apps/server/src/core/health.controller.ts', "@Controller( '/health')\nclass H {}\n")
    // a project domain (erp): its own root, namespace and directories pass
    put('apps/server/src/modules/erp/order/order.controller.ts', controller('erp/orders'))
    put('apps/server/src/modules/Bad_Dir/x.ts')
    put('apps/web/src/locales/zh-CN/crud.json', '{}')
    put('apps/web/src/locales/zh-CN/foo.json', '{}')
    put('apps/web/src/locales/zh-CN/erp.order.json', '{ "erp": {}, "menu": {} }')
    put('apps/web/src/locales/en-US/iam.x.json', '{ "iamx": {} }')
    put('apps/server/src/i18n/zh-CN/signin.json', '{}')
    put('packages/shared/src/i18n/zh-CN/modules/erp.order.json', '{ "field": {} }')
    put('apps/web/src/views/erp/order/index.vue')
    put('apps/web/src/views/home/index.vue')
    put('apps/web/src/views/foo/index.vue')
    put('apps/web/src/api/auth-extra.ts')
    put('packages/shared/src/bar/x.ts')
    // `password-change` and `my-inbox` pass (first segment reserved); `foo-bar` is not, nor listed
    put(
      'apps/web/src/core/router/index.ts',
      "export const LAYOUT = 'layout'\nexport const staticRoutes: X[] = [\n" +
        "  { path: '/password-change', name: 'password-change' },\n" +
        "  { path: '/', name: LAYOUT, children: [{ path: '/inbox', name: 'my-inbox' }] },\n" +
        "  { path: '/x', name: 'foo-bar' },\n]\n",
    )
    const r = spawnSync(
      process.execPath,
      ['../../scripts/arch/run.mjs', '--root', root, '--only', 'reserved-names'],
      { encoding: 'utf8' },
    )
    expect(r.status).toBe(1)
    expect([...r.stderr.matchAll(/ x (\S+):/g)].map(([, v]) => v)).toEqual([
      'apps/server/src/modules/Bad_Dir/',
      'apps/server/src/modules/platform/foo/b.controller.ts',
      'apps/server/src/modules/platform/geo/c.controller.ts',
      'apps/web/src/locales/en-US/iam.x.json',
      'apps/web/src/locales/zh-CN/foo.json',
      'apps/web/src/views/foo/',
      'packages/shared/src/bar/',
      'apps/web/src/core/router/index.ts',
      LISTS,
    ])
    expect(r.stderr).toContain("controller root 'foo'")
    expect(r.stderr).toContain("locale namespace 'iamx'")
    expect(r.stderr).toContain("static route 'foo-bar'")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
