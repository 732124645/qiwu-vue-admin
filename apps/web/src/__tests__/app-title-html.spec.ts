// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { build, createLogger, loadEnv } from 'vite'
import common from '../locales/zh-CN/common.json'
import { appTitle, msg } from '../../e2e/fixtures.ts'
// @ts-expect-error The Node architecture guard is plain JavaScript without a declaration file.
import webDeps from '../../../../scripts/arch/web-deps.mjs'

vi.mock('vite', async (importOriginal) => {
  const original = await importOriginal<typeof import('vite')>()
  return { ...original, loadEnv: vi.fn<typeof original.loadEnv>(original.loadEnv) }
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.mocked(loadEnv).mockReset()
})

it('uses the production build title for Playwright expectations in both locales', async () => {
  vi.stubEnv('VITE_APP_TITLE', undefined)
  const root = await mkdtemp(join(tmpdir(), 'qiwu-e2e-title-'))
  const { loadEnv: actualLoadEnv } = await vi.importActual<typeof import('vite')>('vite')
  vi.mocked(loadEnv).mockImplementation((mode) => actualLoadEnv(mode, root))
  try {
    const title = 'New project title'
    await writeFile(join(root, '.env.production'), `VITE_APP_TITLE=${title}\n`)
    await writeFile(join(root, '.env.development'), 'VITE_APP_TITLE=Development title\n')
    expect(appTitle()).toBe(title)
    expect(appTitle('en-US')).toBe(title)
    expect(loadEnv).toHaveBeenCalledWith(
      'production',
      fileURLToPath(new URL('../../', import.meta.url)),
    )
    await writeFile(join(root, '.env.production'), 'VITE_APP_TITLE=\n')
    expect(appTitle()).toBe(msg('common.app.title'))
    expect(appTitle('en-US')).toBe(msg('common.app.title', 'en-US'))
    await rm(join(root, '.env.production'))
    expect(appTitle()).toBe(msg('common.app.title'))
    expect(appTitle('en-US')).toBe(msg('common.app.title', 'en-US'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('allows Vite in build tests while rejecting it in shipped web code', () => {
  const check = (file: string) =>
    webDeps({
      files: () => [file],
      read: (path: string) =>
        path === 'apps/web/package.json'
          ? JSON.stringify({ devDependencies: { vite: '8' } })
          : "import { build } from 'vite'",
    })
  expect(check('apps/web/src/__tests__/app-title-html.spec.ts')).toEqual([])
  expect(check('apps/web/src/core/build.ts')).toHaveLength(1)
})

it('renders configured and default HTML titles through the actual Vite config', async () => {
  vi.stubEnv('VITE_APP_TITLE', undefined)
  const root = await mkdtemp(join(tmpdir(), 'qiwu-title-'))
  try {
    const html = await readFile(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8')
    // Only exercise the real HTML entry and plugins, without bundling the app or starting a server.
    await writeFile(
      join(root, 'index.html'),
      html.replace(/\s*<script[^>]*>.*?<\/script>/g, '').replace(/\s*<link[^>]*>/g, ''),
    )
    const title = "Demo # 'quoted' \\ title"
    await writeFile(join(root, '.env.development'), `VITE_APP_TITLE=\`${title}\`\n`)
    await writeFile(join(root, '.env.production'), `VITE_APP_TITLE=\`${title}\`\n`)
    for (const [mode, expected] of [
      ['development', title],
      ['production', title],
      ['unset', common.app.title],
      ['empty', common.app.title],
    ]) {
      if (mode === 'empty') await writeFile(join(root, '.env.empty'), 'VITE_APP_TITLE=\n')
      const logger = createLogger('silent')
      const warn = vi.spyOn(logger, 'warn')
      const result = await build({
        configFile: fileURLToPath(new URL('../../vite.config.ts', import.meta.url)),
        root,
        envDir: root,
        mode,
        publicDir: false,
        logLevel: 'silent',
        customLogger: logger,
        build: { write: false },
      })
      if (!('output' in result)) throw new Error('Expected one build output')
      const entry = result.output.find(
        (file) => file.type === 'asset' && file.fileName === 'index.html',
      )
      expect(entry?.type === 'asset' && entry.source).toContain(`<title>${expected}</title>`)
      expect(entry?.type === 'asset' && entry.source).not.toContain('%VITE_APP_TITLE%')
      expect(warn.mock.calls.flat().join(' ')).not.toContain('%VITE_APP_TITLE%')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
