// Dev-mode smoke: Playwright runs `vite build` output, so it misses what only the Vite dev server
// gets wrong (a raw CommonJS dependency, a package split into two module instances by the optimizer).
// Starts the web Vite dev server (no API: /api, /files, /socket.io are aborted) with a fresh dep cache,
// opens it in the local Edge (PW_CHANNEL overrides) and import()s every .vue module under apps/web/src plus
// every bare `import('pkg')` of the source (bpmn-js, shiki, …); then mounts the form designer with one field
// and expects its canvas tool, settings panel and our widget group to render without "Failed to resolve
// component". On a cold cache Vite may discover a dependency late, re-optimize and reload the page
// (504 Outdated Optimize Dep): then the pass runs again (at most MAX_PASSES). Bounded: TIMEOUT_MS.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const webDir = fileURLToPath(new URL('../apps/web/', import.meta.url))
const req = createRequire(join(webDir, 'package.json'))
const TIMEOUT_MS = 240_000
const MAX_PASSES = 4
// per run: two checkouts may run it at once
const cacheDir = mkdtempSync(join(tmpdir(), 'qw-web-dev-smoke-'))

const files = readdirSync(join(webDir, 'src'), { recursive: true })
  .map((f) => f.split('\\').join('/'))
  .filter((f) => !f.includes('__tests__/'))
// the views + the lazy layout route and the components (src/core): every .vue module of the app
const modules = files
  .filter((f) => f.endsWith('.vue'))
  .map((f) => `/src/${f}`)
  .sort()
// the packages the source loads on demand (`import('bpmn-js/lib/Modeler')`): bare specifiers only
const lazyDeps = [
  ...new Set(
    files
      .filter((f) => /\.(vue|ts)$/.test(f))
      .flatMap((f) => [
        ...readFileSync(join(webDir, 'src', f), 'utf8').matchAll(
          /\bimport\(\s*'((?!\.|@\/)[^']+)'\s*\)/g,
        ),
      ])
      .map((m) => m[1]),
  ),
].sort()

// a module the dev server builds like app code (virtual, beside src): the lazy deps + the designer mount
const SMOKE_URL = '/src/__qw_web_dev_smoke__.ts'
const SMOKE_ID = join(webDir, SMOKE_URL).split('\\').join('/')
const smokeModule = `
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { i18n } from '@/core/i18n'
import FormDesigner from '@/views/platform/formkit/FormDesigner.vue'
export const lazy = { ${lazyDeps.map((d) => `'${d}': () => import('${d}')`).join(', ')} }
export function mountDesigner(el) {
  const schema = { rule: [{ type: 'input', field: 'f1', title: 'F1' }], option: {} }
  createApp(FormDesigner, { schema }).use(createPinia()).use(i18n).mount(el)
}`
const smokePlugin = {
  name: 'qw-web-dev-smoke',
  enforce: 'pre',
  resolveId: (id) => (id === SMOKE_URL ? SMOKE_ID : undefined),
  load: (id) => (id === SMOKE_ID ? smokeModule : undefined),
}

/** A fresh page + import() of every module and lazy dep: { page, failures: [url, message][], outdated } */
async function pass(browser, base) {
  const page = await browser.newPage()
  await page.route(
    (u) => /^\/(api|files|socket\.io)\//.test(u.pathname),
    (r) => r.abort(),
  )
  let outdated = false
  page.on('response', (r) => r.status() === 504 && (outdated = true))
  try {
    await page.goto(base, { waitUntil: 'load' })
    const failures = await page.evaluate(
      async ([urls, smoke]) => {
        const out = []
        const load = (name, f) => f().catch((e) => out.push([name, String(e?.message ?? e)]))
        await Promise.all(urls.map((u) => load(u, () => import(u))))
        const m = await import(smoke)
        await Promise.all(Object.entries(m.lazy).map(([d, f]) => load(d, f)))
        return out
      },
      [modules, SMOKE_URL],
    )
    return { page, failures, outdated }
  } catch (e) {
    // a Vite full-reload interrupts the navigation or destroys the context mid-evaluate
    return { page, failures: [['(page)', e.message]], outdated: true }
  }
}

/** The designer renders: its canvas tool, a field's settings (required switch), our widget group. */
async function designer(page) {
  const unresolved = []
  page.on(
    'console',
    (m) => /Failed to resolve component/.test(m.text()) && unresolved.push(m.text().split('\n')[0]),
  )
  await page.evaluate(async (smoke) => {
    const el = Object.assign(document.createElement('div'), { id: 'qw-smoke' })
    el.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#fff;overflow:auto'
    document.body.append(el)
    ;(await import(smoke)).mountDesigner(el)
  }, SMOKE_URL)
  const at = (s) => page.locator(`#qw-smoke ${s}`)
  const step = (what, p) => p.catch((e) => unresolved.push(`${what}: ${e.message.split('\n')[0]}`))
  await step('canvas tool', at('._fd-drag-tool').first().click({ timeout: 15_000 }))
  await step('required switch', at('._fd-required .el-switch').waitFor({ timeout: 5_000 }))
  await step('qw-user-select item', at('._fc-l-item i.icon-person').waitFor({ timeout: 5_000 }))
  return unresolved
}

async function main() {
  const started = Date.now()
  const { createServer } = await import(pathToFileURL(req.resolve('vite')).href)
  const { chromium } = req('@playwright/test')
  let server, browser
  try {
    server = await createServer({
      root: webDir,
      cacheDir,
      logLevel: 'warn',
      plugins: [smokePlugin],
      server: { host: '127.0.0.1', port: 0, strictPort: true, watch: null, forwardConsole: false },
    })
    await server.listen()
    const base = server.resolvedUrls.local[0]
    browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'msedge' })
    const total = modules.length + lazyDeps.length
    let result
    for (let i = 1; ; i++) {
      result = await pass(browser, base)
      const { page, failures, outdated } = result
      const what =
        failures[0]?.[0] === '(page)'
          ? 'page reloaded'
          : `${total - failures.length}/${total} modules ok`
      console.log(`pass ${i}: ${what}${outdated ? ' (deps re-optimized: 504/reload)' : ''}`)
      if (!outdated || i === MAX_PASSES) break
      // the re-optimization ends with a Vite full-reload of that page: wait until 3 s pass without one
      let reloaded = true
      while (reloaded)
        reloaded = await page.waitForEvent('framenavigated', { timeout: 3000 }).then(
          () => true,
          () => false,
        )
      await page.close()
    }
    const secs = () => ((Date.now() - started) / 1000).toFixed(1)
    if (result.failures.length) {
      for (const [u, msg] of result.failures) console.error(`  ✗ ${u}\n    ${msg}`)
      throw new Error(`${result.failures.length} module(s) fail to import in dev mode (${secs()}s)`)
    }
    const broken = await designer(result.page)
    if (broken.length) {
      for (const msg of broken) console.error(`  ✗ ${msg}`)
      throw new Error(`the form designer does not render in dev mode (${secs()}s)`)
    }
    console.log(
      `smoke:web-dev OK: ${modules.length} .vue modules + ${lazyDeps.length} lazy deps import, ` +
        `the form designer renders (${secs()}s)`,
    )
  } finally {
    await browser?.close()
    await server?.close()
    rmSync(cacheDir, { recursive: true, force: true })
  }
}

const hard = setTimeout(() => {
  console.error(`smoke:web-dev FAIL: timeout ${TIMEOUT_MS} ms`)
  rmSync(cacheDir, { recursive: true, force: true })
  process.exit(1) // Playwright kills its browser on exit; the dev server is in-process
}, TIMEOUT_MS)
try {
  await main()
} catch (err) {
  console.error(`smoke:web-dev FAIL: ${err.message}`)
  process.exitCode = 1
} finally {
  clearTimeout(hard)
}
